<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Sentinel VPC Flow Logs — SOP & Templates</title>
  <style>
    :root{--bg:#0f1724;--card:#0b1220;--accent:#0ea5a1;--muted:#94a3b8;--mono:Menlo,Monaco,Consolas,monospace}
    body{font-family:Inter,system-ui,Arial,sans-serif;background:linear-gradient(180deg,#071028 0%,#08142a 100%);color:#e6eef8;margin:0;padding:32px}
    .container{max-width:1100px;margin:0 auto}
    header{display:flex;align-items:center;gap:16px;margin-bottom:18px}
    h1{margin:0;font-size:20px}
    .meta{color:var(--muted);font-size:13px}
    section.card{background:linear-gradient(180deg,rgba(255,255,255,0.02),rgba(255,255,255,0.01));padding:18px;border-radius:12px;margin-bottom:14px;box-shadow:0 6px 18px rgba(2,6,23,0.6)}
    .grid{display:grid;grid-template-columns:1fr 360px;gap:16px}
    pre{background:#061226;padding:12px;border-radius:8px;overflow:auto;color:#dbeafe;font-family:var(--mono);font-size:12px}
    code{font-family:var(--mono);font-size:13px}
    .pill{display:inline-block;background:rgba(255,255,255,0.03);padding:6px 10px;border-radius:999px;font-size:12px;color:var(--muted)}
    .small{font-size:13px;color:var(--muted)}
    summary{cursor:pointer;font-weight:600}
    details{margin-bottom:8px}
    .mermaid{background:#000;padding:8px;border-radius:6px}
    .download{display:inline-block;padding:8px 12px;background:var(--accent);color:#042024;border-radius:8px;text-decoration:none;font-weight:700}
  </style>
  <!-- Mermaid CDN (works when connected to internet) -->
  <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
  <script>mermaid.initialize({startOnLoad:true,theme:'base',securityLevel:'loose'});</script>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>Sentinel VPC Flow Log — SOP, Templates & Runbook</h1>
        <div class="meta">Author: Automation / Architect | Format: GitUpload-ready single HTML</div>
      </div>
      <div style="margin-left:auto;text-align:right">
        <div class="pill">Centralized VPC Flow Logs • 17 regions</div>
      </div>
    </header>

    <section class="card">
      <h2>Summary</h2>
      <p class="small">This document provides a deployable, operational SOP for collecting VPC Flow Logs centrally across AWS Organization member accounts. It contains: architecture diagram (Mermaid), high-level workflow, CloudFormation templates for Tooling/Member/Audit stacks, deployment steps, validation checks, runbooks, troubleshooting, and example automation scripts.</p>
    </section>

    <div class="grid">
      <main>
        <section class="card">
          <h2>Architecture Diagram</h2>
          <div class="mermaid">
            %%{init: {"theme":"neutral"}}%%
            flowchart LR
              subgraph MemberAccount[Member Account]
                A[VPC]
                B[CloudWatch Log Group\nSentinel-VPCFlowLog-All]
                C[FlowLog Role\nSentinel-FlowLog-role-<region>]
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
          </div>
        </section>

        <section class="card">
          <h2>High-level Workflow (condensed)</h2>
          <ol>
            <li>Member stacks create CloudWatch Log Group <code>Sentinel-VPCFlowLog-All</code>, DeliverLogs role, and Manager assume-role for tooling.</li>
            <li>Member stack optionally emits a discovery event into the tooling EventBus on creation.</li>
            <li>Tooling Lambda assumes each member's Manager role and calls <code>CreateFlowLogs</code> with a LogFormat that excludes <code>${flow-log-status}</code>.</li>
            <li>SubscriptionFilter (FilterPattern: <code>- "NODATA"</code>) forwards to Audit CloudWatch Logs Destination.</li>
            <li>Audit CloudWatch Logs Destination → Firehose → S3 (prefix <code>VPCflowLog/</code>) → SQS notifications → Sentinel connector pulls and ingests.</li>
          </ol>
        </section>

        <section class="card">
          <h2>Step‑by‑Step SOP (Deployment)</h2>
          <details open>
            <summary>1. Prepare prerequisites</summary>
            <ul>
              <li>Obtain AWS Organizations OrgId and confirm 17 target regions are enabled.</li>
              <li>Confirm Control Tower / StackSet permissions and roles (if using Control Tower).</li>
            </ul>
          </details>

          <details>
            <summary>2. Deploy Audit (StackSet) in Audit account</summary>
            <ul>
              <li>Deploy Firehose + CloudWatch Logs Destination StackSet to target regions.</li>
              <li>Create central S3 bucket in primary region (example: us-east-1) with prefix <code>VPCflowLog/</code> and configure SQS + notification for suffix <code>.gz</code>.</li>
            </ul>
          </details>

          <details>
            <summary>3. Deploy Tooling CFT to Tooling account</summary>
            <ul>
              <li>Replace <code>PrincipalOrgID</code> with your Org ID in template.</li>
              <li>Deploy in regions you want the tooling Lambda to run.</li>
            </ul>
          </details>

          <details>
            <summary>4. Deploy Member CFT to Member accounts</summary>
            <ul>
              <li>Provide <code>ToolingAccountId</code> and <code>AuditAccountId</code> parameters.</li>
              <li>Confirm the <code>Sentinel-FlowLog-Manager-&lt;region&gt;</code> trust policy allows the tooling account to assume role.</li>
            </ul>
          </details>

          <details>
            <summary>5. Update Tooling Lambda & 6. Cleanup</summary>
            <ul>
              <li>Ensure the flow log <code>LogFormat</code> omits <code>${flow-log-status}</code>.</li>
              <li>Run provided cleanup script to delete old flow logs (sample included below).</li>
            </ul>
          </details>

          <details>
            <summary>7. Trigger manual discovery & 8. Validate</summary>
            <ul>
              <li>Use the multi-region trigger script to put-events into all regions.</li>
              <li>Validate new logs appear in CloudWatch in members, S3 objects under prefix, SQS messages, and Sentinel ingestion metrics.</li>
            </ul>
          </details>
        </section>

        <section class="card">
          <h2>Operational & Troubleshooting Checklist</h2>
          <ul>
            <li>SQS 0 messages — check S3 notifications and queue policy <code>aws:SourceArn</code>.</li>
            <li>S3 files but no data in Sentinel — inspect file contents for <code>NODATA</code> entries.</li>
            <li>Firehose delivery failures — verify bucket policy & Firehose role (s3:PutObject, AbortMultipartUpload, GetBucketLocation).</li>
            <li>Lambda AssumeRole failures — validate trust policy and IAM role ARNs.</li>
            <li>CloudFormation stuck in ROLLBACK — use <code>continue-update-rollback</code> with resource skip and fix IAM/trust issues.</li>
          </ul>
        </section>

        <section class="card">
          <h2>Automation Scripts (examples)</h2>
          <details>
            <summary>Multi-region manual trigger (bash)</summary>
            <pre><code>TOOLING_ACCOUNT=&lt;TOOLAccountID&gt;
REGIONS=(ap-south-1 eu-west-1 eu-central-1 ap-northeast-1 ap-southeast-1 us-east-1 us-west-2 af-south-1)
for r in "${REGIONS[@]}"; do
  aws events put-events --region "$r" --entries "[{\"Source\":\"sentinel.manual.trigger\",\"DetailType\":\"ManualTrigger\",\"Detail\":\"{}\",\"EventBusName\":\"arn:aws:events:${r}:${TOOLING_ACCOUNT}:event-bus/sentinel\"}]"
done</code></pre>
          </details>

          <details>
            <summary>Flow Log cleanup (Python pseudo)</summary>
            <pre><code>import boto3
from botocore.exceptions import ClientError

def delete_old_flowlogs(account_id, role_arn, region):
    sts = boto3.client('sts')
    # assume role and call EC2.describe_flow_logs, delete_flow_logs with tagged Project=Sentinel
    # (Implementation: assume role via sts.assume_role then use ec2 client)
    pass
</code></pre>
          </details>
        </section>

        <section class="card">
          <h2>Bucket Policy (example enforcing bucket-owner-full-control)</h2>
          <pre><code>{
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
</code></pre>
        </section>

        <section class="card">
          <h2>Ready-to-paste CloudFormation Templates (skeletons)</h2>
          <p class="small">Copy the YAML blocks below into files and replace parameter placeholders before uploading to CloudFormation / StackSet.</p>

          <details>
            <summary>Tooling Account (tooling-cft.yaml)</summary>
            <pre><code>AWSTemplateFormatVersion: '2010-09-09'
Description: Sentinel Tooling Stack — EventBus, Lambda (SentinelVPCFlowLambda), Roles
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
      Handler: index.handler
      Runtime: python3.11
      Role: !GetAtt SentinelLambdaRole.Arn
      Timeout: 120
      Environment:
        Variables:
          TOOLING_ACCOUNT: !Ref ToolingAccountId
</code></pre>
          </details>

          <details>
            <summary>Member Account (member-cft.yaml)</summary>
            <pre><code>AWSTemplateFormatVersion: '2010-09-09'
Description: Sentinel Member Stack — Log Group, DeliverLogs Role, Manager Role, Subscription Filter
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
  SentinelFlowLogRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Statement:
          - Effect: Allow
            Principal:
              Service: flowlogs.amazonaws.com
            Action: sts:AssumeRole
      Policies:
        - PolicyName: DeliverLogs
          PolicyDocument:
            Statement:
              - Effect: Allow
                Action:
                  - logs:PutLogEvents
                Resource: '*'
  SentinelFlowLogManagerRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Statement:
          - Effect: Allow
            Principal:
              AWS: !Sub arn:aws:iam::${ToolingAccountId}:root
            Action: sts:AssumeRole
</code></pre>
          </details>

          <details>
            <summary>Audit Account (audit-cft.yaml)</summary>
            <pre><code>AWSTemplateFormatVersion: '2010-09-09'
Description: Sentinel Audit Stack — CloudWatch Logs Destination + Firehose + S3
Parameters:
  CentralS3Bucket:
    Type: String
Resources:
  SentinelFirehoseRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Statement:
          - Effect: Allow
            Principal:
              Service: firehose.amazonaws.com
            Action: sts:AssumeRole
      Policies:
        - PolicyName: FirehoseS3
          PolicyDocument:
            Statement:
              - Effect: Allow
                Action:
                  - s3:PutObject
                  - s3:AbortMultipartUpload
                  - s3:GetBucketLocation
                Resource: !Sub arn:aws:s3:::${CentralS3Bucket}/*
  SentinelFirehoseDeliveryStream:
    Type: AWS::KinesisFirehose::DeliveryStream
    Properties:
      DeliveryStreamType: DirectPut
      ExtendedS3DestinationConfiguration:
        BucketARN: !Sub arn:aws:s3:::${CentralS3Bucket}
        RoleARN: !GetAtt SentinelFirehoseRole.Arn
</code></pre>
          </details>
        </section>

        <section class="card">
          <h2>Validation Checks</h2>
          <ul>
            <li>CloudWatch LogGroup exists and receives flow records (non-NODATA).</li>
            <li>SubscriptionFilter in member account exists and PutSubscriptionFilter succeeded (check CloudWatch Logs Destination policy).</li>
            <li>Firehose metrics: DeliveryToS3.Success, Failed puts = 0.</li>
            <li>S3 objects landing under <code>VPCflowLog/</code> with <code>.gz</code> suffix.</li>
            <li>SQS receives notifications and Sentinel connector processes messages.</li>
          </ul>
        </section>

        <section class="card">
          <h2>Best practices & Recommendations</h2>
          <ul>
            <li>Use stable Firehose prefix <code>VPCflowLog/!{timestamp:yyyy}/</code> and lifecycle rules for cost control.</li>
            <li>FilterPattern: <code>- "NODATA"</code> to avoid NODATA records.</li>
            <li>Tag resources consistently (Project=Sentinel) for lifecycle and cleanup.</li>
            <li>Monitor Firehose and S3 metrics; alert on sudden drops in object counts.</li>
          </ul>
        </section>

      </main>

      <aside>
        <section class="card">
          <h3>Quick Links</h3>
          <p class="small">Use these sections to copy templates and scripts quickly into Git.</p>
          <a class="download" href="#" onclick="downloadHTML();return false;">Download HTML</a>
        </section>

        <section class="card">
          <h3>Checklist (short)</h3>
          <ol>
            <li>Create Audit stack & S3/SQS</li>
            <li>Deploy Tooling stack</li>
            <li>Deploy Member stacks</li>
            <li>Run cleanup script</li>
            <li>Trigger discovery</li>
            <li>Validate ingestion</li>
          </ol>
        </section>

        <section class="card">
          <h3>Contact / Notes</h3>
          <p class="small">Keep IAM role names stable: <code>Sentinel-FlowLog-role-&lt;region&gt;</code> and <code>Sentinel-FlowLog-Manager-&lt;region&gt;</code>. Use tags for ownership and cleanup.</p>
        </section>
      </aside>
    </div>

    <footer style="margin-top:18px;color:var(--muted);font-size:13px">Generated: Sentinel VPC Flow Log SOP — ready to save into your Git repository as <strong>sentinel-vpc-flowlogs-sop.html</strong></footer>
  </div>

  <script>
    function downloadHTML(){
      const blob = new Blob([document.documentElement.outerHTML],{type:'text/html'});
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'sentinel-vpc-flowlogs-sop.html';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }
  </script>
</body>
</html>
