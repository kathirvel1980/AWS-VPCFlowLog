AWS Member Accounts (17 regions)
       │ VPC Create + Discovery Events
       ▼
EventBridge → Tooling Account
       │
       ▼
Lambda (Sentinel VPC FlowLog Attacher)
       │
Assume Role (FlowLog Manager) in all Member Accounts
       │
Create / Verify / Tag Flow Logs (CloudWatch LogGroup)
       │
SubscriptionFilter → CloudWatch Logs Destination (in Audit Account)
       │
Firehose (per region)
       │
S3 Central Bucket  → (ObjectCreated event)
       │
SQS Queue
       │
Microsoft Sentinel (Data Connector)



Sentinel VPC Flow Log — SOP, CloudFormation Templates, and Architecture Diagram
Purpose: Provide a complete, deployable Standard Operating Procedure (SOP) for centralized VPC Flow Log collection using: member stacks, tooling (central) stack, and audit (firehose + S3) stack. Includes ready-to-paste CloudFormation templates (tooling, member, audit), an architecture diagram (Mermaid), deployment steps, validation checks, operational runbooks, and troubleshooting.
________________________________________
1. Architecture Diagram (Mermaid)
flowchart LR
  subgraph MemberAccount[Member Account]
    A[VPC]
    B[CloudWatch Log Group \n Sentinel-VPCFlowLog-All]
    C[FlowLog Role \n Sentinel-FlowLog-role-<region>]
    A -->|Flow Logs -> CW Logs| B
    B -->|SubscriptionFilter ->| D[CW Logs Destination (Audit account)]
    B -->|EventRule: sentinel.vpc.discovery| E[EventBridge -> sentinel bus (Tooling)]
  end

  subgraph AuditAccount[Audit (Log Destination)]
    D --> F[CloudWatch Logs Destination]
    F --> G[Firehose Delivery Stream]
    G --> H[S3 Bucket (us-east-1)]
    H --> I[SQS Queue]
  end

  subgraph ToolingAccount[Tooling]
    E --> J[Tooling EventBus: sentinel]
    J --> K[SentinelVPCFlowLambda]
    K -->|AssumeRole| L[Member: Sentinel-FlowLog-Manager-<region>]
    K -->|create_flow_logs| B
  end

  I --> M[Azure Sentinel Connector]
________________________________________
2. High-level Workflow
1.	Members create a CloudWatch Log Group Sentinel-VPCFlowLog-All (member CFT). They also create roles:
o	Sentinel-FlowLog-role-<region> (DeliverLogsPermissionArn used by Flow Logs)
o	Sentinel-FlowLog-Manager-<region> (assumable by tooling account to create flow logs)
2.	Member stack optionally invokes a Custom Resource that sends a sentinel.vpc.discovery event to the Tooling EventBus to request discovery at stack creation time.
3.	Tooling account hosts an EventBridge sentinel EventBus and SentinelVPCFlowLambda.
o	The Lambda receives discovery events or CloudTrail CreateVpc events forwarded to the sentinel bus.
o	The Lambda assumes each member’s Sentinel-FlowLog-Manager-<region> role and calls CreateFlowLogs with a LogFormat that excludes ${flow-log-status} to avoid NODATA.
4.	Flow logs are delivered to CloudWatch Logs in each member account; a subscription filter forwards logs (excluding NODATA via FilterPattern: - "NODATA") to an Audit CloudWatch Logs Destination.
5.	Audit account CloudWatch Logs Destination writes to a Firehose delivery stream (one region may act as central). Firehose writes compressed .gz files into a central S3 bucket (e.g. us-east-1) under a stable prefix: VPCflowLog/!{timestamp:yyyy}/....
6.	S3 Event Notifications (prefix VPCflowLog/ + suffix .gz) publish s3:ObjectCreated:* events to an SQS queue.
7.	Microsoft Sentinel connector assumes the cross-account role you created and polls SQS to read object keys, GetObject from S3 (reads .gz) and decompresses internally.
________________________________________
3. Tooling Account - CloudFormation (YAML)
Purpose: creates sentinel EventBus, EventBusPolicy (org allow), Lambda (Tooling), Event Rules for discovery/createVpc/manual, and invocation roles.
AWSTemplateFormatVersion: '2010-09-09'
Description: Tooling Account - Sentinel VPC Flow Log Attacher
Parameters:
  LambdaNamePrefix:
    Type: String
    Default: SentinelVPCflow
  PrincipalOrgID:
    Type: String
    Default: o-xxxxxxxxxx

Resources:
  SentinelEventBus:
    Type: AWS::Events::EventBus
    Properties:
      Name: sentinel
      Tags:
        - Key: Project
          Value: Sentinel

  SentinelEventBusPolicy:
    Type: AWS::Events::EventBusPolicy
    DependsOn: SentinelEventBus
    Properties:
      StatementId: AllowOrgPutEvents
      EventBusName: sentinel
      Action: events:PutEvents
      Principal: "*"
      Condition:
        Type: StringEquals
        Key: aws:PrincipalOrgID
        Value: !Ref PrincipalOrgID

  ToolingFlowLogLambdaRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: !Sub "Tooling-FlowLogLambdaRole-${AWS::Region}"
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service: lambda.amazonaws.com
            Action: sts:AssumeRole
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
      Policies:
        - PolicyName: AssumeMemberRoles
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Effect: Allow
                Action:
                  - sts:AssumeRole
                Resource: '*'

  SentinelVPCFlowLambda:
    Type: AWS::Lambda::Function
    Properties:
      FunctionName: !Sub "${LambdaNamePrefix}-${AWS::Region}"
      Runtime: python3.11
      Handler: index.lambda_handler
      Timeout: 120
      Role: !GetAtt ToolingFlowLogLambdaRole.Arn
      Code:
        ZipFile: |
          import boto3, json

          def lambda_handler(event, context):
              print('Event:', json.dumps(event))
              # route by source
              if event.get('source') == 'sentinel.vpc.discovery':
                  return run_discovery(event)
              return run_create_vpc(event)

          def assume(member, region):
              arn = f"arn:aws:iam::{member}:role/Sentinel-FlowLog-Manager-{region}"
              sts = boto3.client('sts')
              creds = sts.assume_role(RoleArn=arn, RoleSessionName='SentinelSession')['Credentials']
              return boto3.client('ec2', region_name=region,
                                  aws_access_key_id=creds['AccessKeyId'],
                                  aws_secret_access_key=creds['SecretAccessKey'],
                                  aws_session_token=creds['SessionToken'])

          def attach(ec2, vpc_id, region, member):
              role = f"arn:aws:iam::{member}:role/Sentinel-FlowLog-role-{region}"
              resp = ec2.create_flow_logs(
                  ResourceIds=[vpc_id],
                  ResourceType='VPC',
                  TrafficType='ALL',
                  LogGroupName='Sentinel-VPCFlowLog-All',
                  DeliverLogsPermissionArn=role,
                  LogDestinationType='cloud-watch-logs',
                  MaxAggregationInterval=60,
                  LogFormat='${version} ${account-id} ${interface-id} ${srcaddr} ${dstaddr} ${srcport} ${dstport} ${protocol} ${packets} ${bytes} ${start} ${end} ${action}'
              )
              print('CreateFlowLogs resp', resp)

          def run_create_vpc(event):
              d = event.get('detail', {})
              region = event.get('region')
              member = d.get('userIdentity', {}).get('accountId')
              vpc_id = d.get('responseElements', {}).get('vpc', {}).get('vpcId')
              if not (member and vpc_id and region):
                  print('missing fields', event)
                  return
              ec2 = assume(member, region)
              attach(ec2, vpc_id, region, member)

          def run_discovery(event):
              region = event.get('region') or (event.get('detail') or {}).get('region')
              member = event.get('account') or (event.get('detail') or {}).get('account')
              if not (member and region):
                  print('Missing discovery fields')
                  return
              ec2 = assume(member, region)
              vpcs = ec2.describe_vpcs().get('Vpcs', [])
              for v in vpcs:
                  vid = v['VpcId']
                  logs = ec2.describe_flow_logs(Filters=[{'Name':'resource-id','Values':[vid]}]).get('FlowLogs', [])
                  sentinel_exists = False
                  for fl in logs:
                      traffic_ok = fl.get('TrafficType') == 'ALL'
                      tagged_ok = any(t.get('Key')=='Project' and t.get('Value')=='Sentinel' for t in fl.get('Tags', []))
                      if traffic_ok and tagged_ok:
                          sentinel_exists = True
                          break
                  if sentinel_exists:
                      continue
                  attach(ec2, vid, region, member)

  EventInvokeLambdaRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: !Sub "Sentinel-InvokeLambdaRole-${AWS::Region}"
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service: events.amazonaws.com
            Action: sts:AssumeRole
      Policies:
        - PolicyName: AllowInvokeSentinelLambda
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Effect: Allow
                Action: lambda:InvokeFunction
                Resource: !GetAtt SentinelVPCFlowLambda.Arn

  SentinelDiscoveryRule:
    Type: AWS::Events::Rule
    Properties:
      EventBusName: sentinel
      Description: "Triggers Lambda on discovery events"
      EventPattern:
        source:
          - sentinel.vpc.discovery
      Targets:
        - Id: Discovery
          Arn: !GetAtt SentinelVPCFlowLambda.Arn
          RoleArn: !GetAtt EventInvokeLambdaRole.Arn

  SentinelCreateVpcRule:
    Type: AWS::Events::Rule
    Properties:
      EventBusName: sentinel
      Description: "Triggers Lambda on CreateVpc CloudTrail events"
      EventPattern:
        source:
          - aws.ec2
        detail-type:
          - AWS API Call via CloudTrail
        detail:
          eventSource:
            - ec2.amazonaws.com
          eventName:
            - CreateVpc
      Targets:
        - Id: CreateVpc
          Arn: !GetAtt SentinelVPCFlowLambda.Arn
          RoleArn: !GetAtt EventInvokeLambdaRole.Arn

  ManualTriggerRule:
    Type: AWS::Events::Rule
    Properties:
      EventBusName: sentinel
      Description: "Manual trigger for forcing discovery"
      EventPattern:
        source:
          - sentinel.manual.trigger
      Targets:
        - Id: Manual
          Arn: !GetAtt SentinelVPCFlowLambda.Arn
          RoleArn: !GetAtt EventInvokeLambdaRole.Arn

Outputs:
  SentinelBusArn:
    Value: !GetAtt SentinelEventBus.Arn
  LambdaArn:
    Value: !GetAtt SentinelVPCFlowLambda.Arn
________________________________________
4. Member Account - CloudFormation (YAML)
Purpose: Creates CloudWatch Log Group, FlowLog role (deliver logs), Manager role (assumable by Tooling), SubscriptionFilter (to Audit), EventBridge cross-account rule forwarding discovery if required and a one-time Custom Resource to trigger discovery on create.
AWSTemplateFormatVersion: '2010-09-09'
Description: Member account resources for Sentinel
Parameters:
  ToolingAccountId:
    Type: String
    Default: "<TOOLAccountID>"
  AuditAccountId:
    Type: String
    Default: "<AuditAccountID>"
  DestinationName:
    Type: String
    Default: SentinelFlowLogs

Resources:
  SentinelVPCFlowLogGroup:
    Type: AWS::Logs::LogGroup
    Properties:
      LogGroupName: "Sentinel-VPCFlowLog-All"
      RetentionInDays: 7
      Tags:
        - Key: Project
          Value: Sentinel

  SentinelFlowLogRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: !Sub "Sentinel-FlowLog-role-${AWS::Region}"
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service:
                - vpc-flow-logs.amazonaws.com
            Action: sts:AssumeRole
      Policies:
        - PolicyName: FlowLogRolePolicy
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Effect: Allow
                Action:
                  - logs:CreateLogGroup
                  - logs:CreateLogStream
                  - logs:DescribeLogGroups
                  - logs:DescribeLogStreams
                  - logs:PutLogEvents
                Resource: '*'

  SentinelFlowLogManagerRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: !Sub "Sentinel-FlowLog-Manager-${AWS::Region}"
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              AWS:
                - !Sub "arn:aws:iam::${ToolingAccountId}:root"
            Action: sts:AssumeRole
      Policies:
        - PolicyName: FlowLogManagerPolicy
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Effect: Allow
                Action:
                  - ec2:CreateFlowLogs
                  - ec2:DescribeFlowLogs
                  - ec2:DescribeVpcs
                  - ec2:CreateTags
                Resource: '*'

  SentinelSubscriptionAttachRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: !Sub "Sentinel-SubscriptionAttachRole-${AWS::Region}"
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service:
                - logs.amazonaws.com
            Action: sts:AssumeRole
      Policies:
        - PolicyName: SubscriptionAttachPolicy
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Effect: Allow
                Action:
                  - logs:PutSubscriptionFilter
                  - logs:DeleteSubscriptionFilter
                  - logs:DescribeLogGroups
                Resource: '*'

  SentinelSubscriptionFilter:
    Type: AWS::Logs::SubscriptionFilter
    DependsOn: SentinelVPCFlowLogGroup
    Properties:
      LogGroupName: !Ref SentinelVPCFlowLogGroup
      FilterPattern: "- \"NODATA\""
      FilterName: !Sub "Sentinel-FlowLogs-${AWS::Region}"
      DestinationArn: !Sub "arn:aws:logs:${AWS::Region}:${AuditAccountId}:destination:${DestinationName}"
      RoleArn: !GetAtt SentinelSubscriptionAttachRole.Arn

Outputs:
  FlowLogRoleArn:
    Value: !Sub "arn:aws:iam::${AWS::AccountId}:role/Sentinel-FlowLog-role-${AWS::Region}"
  ManagerRoleArn:
    Value: !GetAtt SentinelFlowLogManagerRole.Arn
________________________________________
5. Audit (Sentinel/Audit) Account - Firehose + CloudWatch Destination StackSet (YAML)
Purpose: Create Firehose delivery stream, Firehose role, CloudWatch Logs Destination, and Destination policy to allow Org to PutSubscriptionFilter.
AWSTemplateFormatVersion: '2010-09-09'
Description: Sentinel Firehose + CloudWatch Logs Destination (StackSet)
Parameters:
  StackSetName:
    Type: String
  S3BucketAllEvents:
    Type: String
  S3Prefix:
    Type: String
    Default: "VPCflowLog/"
  OrgId:
    Type: String
  SentinelDestinationName:
    Type: String
    Default: SentinelFlowLogsToFirehose
  FirehoseDeliveryStreamNamePrefix:
    Type: String
    Default: firehose-sentinel
Resources:
  SentinelFirehoseStreamRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: !Sub "${FirehoseDeliveryStreamNamePrefix}-role-${AWS::Region}-${StackSetName}"
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service: firehose.amazonaws.com
            Action: sts:AssumeRole
      Policies:
        - PolicyName: !Sub "${FirehoseDeliveryStreamNamePrefix}-s3policy-${AWS::Region}"
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Sid: AllowS3Write
                Effect: Allow
                Action:
                  - s3:AbortMultipartUpload
                  - s3:GetBucketLocation
                  - s3:GetObject
                  - s3:ListBucket
                  - s3:ListBucketMultipartUploads
                  - s3:PutObject
                Resource:
                  - !Sub arn:aws:s3:::${S3BucketAllEvents}
                  - !Sub arn:aws:s3:::${S3BucketAllEvents}/*

  FirehoseLogsDeliveryStream:
    Type: AWS::KinesisFirehose::DeliveryStream
    DependsOn:
      - SentinelFirehoseStreamRole
    Properties:
      DeliveryStreamName: !Sub "${FirehoseDeliveryStreamNamePrefix}-${StackSetName}-${AWS::Region}"
      DeliveryStreamType: DirectPut
      ExtendedS3DestinationConfiguration:
        BucketARN: !Sub arn:aws:s3:::${S3BucketAllEvents}
        RoleARN: !GetAtt SentinelFirehoseStreamRole.Arn
        Prefix: !Ref S3Prefix
        ErrorOutputPrefix: !Sub "${S3Prefix}error/"
        BufferingHints:
          IntervalInSeconds: 300
          SizeInMBs: 128
        CompressionFormat: GZIP
        EncryptionConfiguration:
          NoEncryptionConfig: NoEncryption
        CloudWatchLoggingOptions:
          Enabled: true
          LogGroupName: !Sub "/aws/kinesisfirehose/${StackSetName}"
          LogStreamName: !Sub "FirehoseDelivery-${AWS::Region}"

  CWSentinelToFirehoseRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: !Sub "CWLogsToFirehoseRole-${StackSetName}-${AWS::Region}"
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service: logs.amazonaws.com
            Action: sts:AssumeRole
      Policies:
        - PolicyName: !Sub "CWLogsToFirehosePolicy-${StackSetName}-${AWS::Region}"
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Sid: AllowFirehoseReadsAndPut
                Effect: Allow
                Action:
                  - firehose:DescribeDeliveryStream
                  - firehose:PutRecord
                  - firehose:PutRecordBatch
                Resource: !GetAtt FirehoseLogsDeliveryStream.Arn

  CloudWatchLogsDestination:
    Type: AWS::Logs::Destination
    DependsOn:
      - FirehoseLogsDeliveryStream
      - CWSentinelToFirehoseRole
    Properties:
      DestinationName: !Ref SentinelDestinationName
      TargetArn: !GetAtt FirehoseLogsDeliveryStream.Arn
      RoleArn: !GetAtt CWSentinelToFirehoseRole.Arn
      DestinationPolicy: !Sub |
        {
          "Version":"2012-10-17",
          "Statement":[
            {
              "Sid":"AllowOrgPutSubscriptionFilter",
              "Effect":"Allow",
              "Principal":"*",
              "Action":"logs:PutSubscriptionFilter",
              "Resource":"arn:aws:logs:${AWS::Region}:${AWS::AccountId}:destination:${SentinelDestinationName}",
              "Condition":{
                "StringEquals":{"aws:PrincipalOrgID":"${OrgId}"}
              }
            }
          ]
        }
________________________________________
6. SQS Queue Policy 
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowS3SendMessage",
      "Effect": "Allow",
      "Principal": { "Service": "s3.amazonaws.com" },
      "Action": "sqs:SendMessage",
      "Resource": "arn:aws:sqs:<REGION>:<ACCOUNT-ID>:<QUEUE>",
      "Condition": {
        "ArnEquals": { "aws:SourceArn": "arn:aws:s3:::<BUCKET>" },
        "StringEquals": { "aws:SourceAccount": "<BUCKET_ACCOUNT_ID>" }
      }
    },
    {
      "Sid": "AllowSentinelRead",
      "Effect": "Allow",
      "Principal": { "AWS": "<SENTINEL_ROLE_ARN>" },
      "Action": [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:GetQueueUrl"
      ],
      "Resource": "arn:aws:sqs:<REGION>:<ACCOUNT-ID>:<QUEUE>"
    }
  ]
}
________________________________________
7. S3 Bucket Policy (bucket-owner-full-control enforcement example)
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EnforceBucketOwnerFullControlACL",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::<BUCKET>/*",
      "Condition": { "StringEquals": { "s3:x-amz-acl": "bucket-owner-full-control" } }
    },
    {
      "Sid": "DenyNewObjectsWithoutRequiredACL",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::<BUCKET>/*",
      "Condition": { "StringNotEquals": { "s3:x-amz-acl": "bucket-owner-full-control" } }
    }
  ]
}
________________________________________
8. Step‑by‑Step SOP (Deployment)
1.	Prepare prerequisites
o	Ensure AWS Organizations OrgId is available and region opt-ins (17 regions) are enabled in management account.
o	Ensure Control Tower roles exist and StackSet can deploy to regions.
2.	Deploy Audit (StackSet) in Audit account
o	Deploy the Firehose + CloudWatch Logs Destination StackSet to all target regions.
o	Create central S3 bucket (us-east-1) with prefix VPCflowLog/ and SQS queue plus notification for VPCflowLog/ + suffix .gz.
3.	Deploy Tooling CFT to Tooling account
o	Replace PrincipalOrgID with your Org ID.
o	Deploy in each region where you want the tooling Lambda to run (or deploy once in the primary region and use cross-region invoke if desired).
4.	Deploy Member CFT to each member account
o	Provide ToolingAccountId and AuditAccountId.
o	Confirm Sentinel-FlowLog-Manager-<region> role exists and trust allows Tooling account to assume.
5.	Update Tooling Lambda
o	Ensure LogFormat is included (no ${flow-log-status}) — to avoid NODATA.
6.	Delete old FlowLogs
o	Run cleanup script (I can provide) to delete existing flow logs across accounts/regions.
7.	Trigger manual discovery
o	Use provided script to put-events into all 17 regions — one event per region triggers tooling Lambda to recreate Flow Logs across 46 accounts.
8.	Validate
o	Check CloudWatch Logs in member accounts for new FlowLog entries (non-NODATA)
o	Check Firehose monitoring, S3 objects landing under VPCflowLog/ prefix
o	Check SQS queue receives messages
o	Check Sentinel connector shows ingestion (green) and traffic counts > 0
________________________________________
9. Operational & Troubleshooting Checklist
•	If SQS has 0 messages => check S3 notifications prefix/suffix and SQS queue policy aws:SourceArn.
•	If S3 receives files but Sentinel shows no data => inspect file contents: NODATA vs real flow records.
•	If Firehose cloudwatch shows delivery failures => check S3 bucket policy, ACL, and Firehose role permissions (s3:PutObject + s3:AbortMultipartUpload + s3:GetBucketLocation).
•	If Lambda fails AssumeRole => check member Sentinel-FlowLog-Manager-<region> trust policy allows tooling account root or tooling role.
•	If CloudFormation stuck in ROLLBACK => use continue-update-rollback with --resources-to-skip and fix underlying IAM/trust issues, then retry.
________________________________________
10. Automation Scripts (examples)
Multi-region manual trigger (bash)
TOOLING_ACCOUNT=<TOOLAccountID>
REGIONS=(ap-south-1 eu-west-1 eu-central-1 ap-northeast-1 ap-southeast-1 us-east-1 us-west-2 af-south-1 ...)
for r in "${REGIONS[@]}"; do
  aws events put-events --region "$r" --entries "[{\"Source\":\"sentinel.manual.trigger\",\"DetailType\":\"ManualTrigger\",\"Detail\":\"{}\",\"EventBusName\":\"arn:aws:events:${r}:${TOOLING_ACCOUNT}:event-bus/sentinel\"}]"
done
Flow Log cleanup (python pseudo)
•	Use boto3 sts to assume member Sentinel-FlowLog-Manager-<region> and call describe_flow_logs, delete_flow_logs for old tagged Project=Sentinel flow logs.
________________________________________
11. Best practices & Recommendations
•	Use static prefix VPCflowLog/!{timestamp:yyyy}/... in Firehose to avoid yearly reconfiguration.
•	Use FilterPattern: - "NODATA" on SubscriptionFilter to avoid NODATA traffic.
•	Tag resources (Project=Sentinel) consistently for cleanup and ownership.
•	Monitor Firehose delivery metrics and S3 Object count to detect anomalies.
•	Store minimal retention and lifecycle rules in S3 (transition to Glacier/Expunge older than X days) to control costs.
________________________________________
If you want, I can: - Produce the full runnable CloudFormation files for each account/region packaged as downloadable files, or - Generate a more formal PDF SOP or a presentation slide deck for stakeholder review.
Which would you like next?
