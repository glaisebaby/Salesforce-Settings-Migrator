`migrate-location-group.js` copies a specific `LocationGroup` and its `Location` members from one authenticated Salesforce org to another.

Example:

```powershell
node scripts/migrate-location-group.js --source uat --target uat2
```

Optional flags:

```powershell
node scripts/migrate-location-group.js --source uat --target uat2 --group ECOMM_GROUP --locations "CALI,558-DC,558-DCBLK,VANCOUVER"
```
