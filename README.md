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
