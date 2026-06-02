List<SObject> updates = new List<SObject>();
for (String recordId : new List<String>{'131O10000034w0WIAQ','131O10000034w0VIAQ','131O10000034w0YIAQ'}) {
    SObject row = Schema.getGlobalDescribe().get('Location').newSObject(recordId);
    row.put('Line2__c', null);
    updates.add(row);
}
update updates;
System.debug('Cleared Line2__c on 3 uat2 locations.');
