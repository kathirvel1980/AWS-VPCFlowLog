# Sentinel VPC Flow Logs — SOP, Architecture, CloudFormation Templates

A complete, production-grade Standard Operating Procedure (SOP) for centralized multi-account, multi‑region VPC Flow Log collection with AWS Organizations, EventBridge, Lambda automation, CloudWatch Logs Destinations, Firehose, S3, SQS, and Microsoft Sentinel.

This **README.md** is structured for direct upload to Git repositories (GitHub/GitLab/CodeCommit).

---

## 📘 Overview

This repository delivers end‑to‑end automation for collecting VPC Flow Logs from **all AWS member accounts across 17 regions**, routing them into a central **Audit (Sentinel) account**, and forwarding logs to **Microsoft Sentinel**.

It includes:

* Architecture diagrams (Mermaid)
* Tooling, Member, and Audit CloudFormation Templates
* Deployment SOP (step-by-step)
* Operational runbooks & troubleshooting
* Automation scripts
* IAM policies, bucket policies, and setup requirements

---

## 📐 Architecture Diagram (Mermaid)

```mermaid
flowchart LR
  subgraph Member_Account["Member Account"]
    A[VPC]
    B["CloudWatch Log Group - Sentinel-VPCFlowLog-All"]
    C["FlowLog Role - Sentinel-FlowLog-role-<region>"]
    A -->|"Flow Logs → CloudWatch Logs"| B
    B -->|"SubscriptionFilter → Audit Destination"| D
    B -->|"Event Rule: sentinel.vpc.discovery"| E
  end

  subgraph Audit_Account["Audit Account"]
    D["CloudWatch Logs Destination"]
    F["Firehose Delivery Stream"]
    G["Central S3 Bucket (us-east-1)"]
    H["SQS Queue"]
    D --> F
    F --> G
    G --> H
  end

  subgraph Tooling_Account["Tooling Account"]
    E --> J["EventBridge Bus: sentinel"]
    J --> K["SentinelVPCFlowLambda"]
    K -->|"AssumeRole"| L["Sentinel-FlowLog-Manager-<region>"]
    K -->|"Create / Verify Flow Logs"| B
  end

  H --> M["Microsoft Sentinel Connector"]


## 🚀 High-Level Workflow

1. **Member Account Stack** creates:

   * CloudWatch Log Group: `Sentinel-VPCFlowLog-All`
   * DeliverLogs IAM Role
   * Manager AssumeRole (for Tooling Lambda)
   * Subscription Filter → Audit Destination
2. **Tooling Account Stack** hosts EventBus + Lambda to auto‑attach flow logs for all VPCs.
3. Lambda assumes member roles, creates VPC Flow Logs with LogFormat (no `${flow-log-status}`).
4. SubscriptionFilter forwards logs to **Audit CloudWatch Logs Destination**.
5. Destination → **Firehose → S3 → SQS**.
6. Microsoft **Sentinel Connector** polls SQS and ingests compressed `.gz` objects.

---

## 📦 Repository Structure

```
├── README.md                           # This file
├── tooling-cft.yaml                    # Tooling Account CloudFormation
├── member-cft.yaml                     # Member Account CloudFormation
├── audit-cft.yaml                      # Audit/Firehose Destination CFT
├── scripts/
│   ├── trigger-discovery.sh           # Multi‑region EventBridge trigger
│   ├── cleanup-old-flowlogs.py        # Python script for flowlog cleanup
├── policies/
│   ├── s3-bucket-policy.json          # Enforce bucket-owner-full-control
```

---

## 🏗️ CloudFormation Templates

### Tooling Account — `tooling-cft.yaml`

Creates:

* `sentinel` EventBus
* Lambda: **SentinelVPCFlowLambda**
* Lambda execution role

```yaml
AWSTemplateFormatVersion: '2010-09-09'
Description: Sentinel Tooling Stack — EventBus, Lambda, Roles
Parameters:
  ToolingAccountId:
    Type: String
  PrincipalOrgID:
    Type: String
Resources:
  SentinelEventBus:
    Type: AWS::Events::EventBus
    Properties:
      Name: sentinel

  SentinelLambdaRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Statement:
          - Effect: Allow
            Principal:
              Service: lambda.amazonaws.com
            Action: sts:AssumeRole
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

  SentinelVPCFlowLambda:
    Type: AWS::Lambda::Function
    Properties:
      Runtime: python3.11
      Handler: index.handler
      Timeout: 120
      Role: !GetAtt SentinelLambdaRole.Arn
```

---

### Member Account — `member-cft.yaml`

Creates:

* LogGroup `Sentinel-VPCFlowLog-All`
* DeliverLogs Role
* Manager AssumeRole
* SubscriptionFilter to Audit Destination

```yaml
AWSTemplateFormatVersion: '2010-09-09'
Description: Sentinel Member Stack
Parameters:
  ToolingAccountId:
    Type: String
  AuditAccountId:
    Type: String
Resources:
  SentinelVPCFlowLogGroup:
    Type: AWS::Logs::LogGroup
    Properties:
      LogGroupName: Sentinel-VPCFlowLog-All
      RetentionInDays: 90
```

(Full template continues… add your IAM/SubscriptionFilter sections.)

---

### Audit Account — `audit-cft.yaml`

Contains:

* CloudWatch Logs Destination
* Firehose delivery stream
* IAM Role

```yaml
AWSTemplateFormatVersion: '2010-09-09'
Description: Sentinel Audit Stack
Parameters:
  CentralS3Bucket:
    Type: String
Resources:
  SentinelFirehoseRole:
    Type: AWS::IAM::Role
      ...
```

---

## ⚙️ S3 Bucket Policy (recommended)

```json
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
```

---

## 🧭 Step‑by‑Step Deployment SOP

### 1. Prerequisites

* Get AWS Organizations **OrgID**.
* Enable all required **17 regions**.
* S3/SQS/SNS must be region‑consistent.

### 2. Deploy Audit Stack

* Deploy Firehose + CloudWatch Destination into all 17 regions.
* Create central S3 bucket (example: `us-east-1`).

### 3. Deploy Tooling Stack

* Deploy to your Tooling account.
* Update `PrincipalOrgID`.

### 4. Deploy Member Stack

* Deploy to all member accounts.
* Ensure Manager AssumeRole is correct.

### 5. Clean old Flow Logs

* Use cleanup script.

### 6. Trigger Discovery Event

```bash
bash trigger-discovery.sh
```

### 7. Validate

* CloudWatch log groups receive new flow records.
* Firehose → S3 objects created.
* SQS queue receives messages.
* Microsoft Sentinel shows data ingestion.

---

## 🔧 Automation Scripts

### Multi‑Region Event Trigger

```bash
TOOLING_ACCOUNT=<ID>
REGIONS=(ap-south-1 eu-west-1 us-east-1 ...)
for r in "${REGIONS[@]}"; do
  aws events put-events --region "$r" --entries "[{\"Source\":\"sentinel.manual.trigger\",\"DetailType\":\"ManualTrigger\",\"Detail\":\"{}\",\"EventBusName\":\"arn:aws:events:${r}:${TOOLING_ACCOUNT}:event-bus/sentinel\"}]"
done
```

### Flow Log Cleanup Script (Python)

```python
import boto3

def cleanup(account_id, role_arn, region):
    sts = boto3.client('sts')
    creds = sts.assume_role(RoleArn=role_arn, RoleSessionName='cleanup')
    ec2 = boto3.client('ec2', region_name=region,
                       aws_access_key_id=creds['Credentials']['AccessKeyId'],
                       aws_secret_access_key=creds['Credentials']['SecretAccessKey'],
                       aws_session_token=creds['Credentials']['SessionToken'])

    logs = ec2.describe_flow_logs()['FlowLogs']
    ids = [l['FlowLogId'] for l in logs if l.get('Tags', [{'Value': ''}])[0]['Value']=='Sentinel']

    if ids:
        ec2.delete_flow_logs(FlowLogIds=ids)
```

---

## 🔍 Troubleshooting Guide

| Issue                               | Check                                                     |
| ----------------------------------- | --------------------------------------------------------- |
| No SQS messages                     | Verify S3 → SQS notification, prefix/suffix, queue policy |
| S3 objects exist but Sentinel empty | Likely `NODATA` flow logs—check LogFormat                 |
| Firehose delivery failure           | Bucket policy, IAM role permissions                       |
| Lambda AssumeRole error             | Check member role trust policy                            |
| CloudFormation rollback             | Use `continue-update-rollback` and fix IAM/trust          |

---

## 🏅 Best Practices

* Always exclude `${flow-log-status}` in LogFormat to avoid NODATA.
* Use S3 prefix structure: `VPCflowLog/!{timestamp:yyyy}/...`.
* Add lifecycle policies for cost optimization.
* Tag resources: `Project=Sentinel`.

---

## 📄 License

Internal Use Only — Copyright © Your Organization.
