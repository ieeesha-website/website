/**
 * One-time repair and migration for submission uniqueness indexes.
 *
 * This deliberately drops only the two submission uniqueness indexes whose
 * definitions changed; it never uses syncIndexes(), which can remove unrelated
 * indexes. Existing duplicate member or guest submissions are reported before
 * any indexes are changed.
 *
 * Usage: node utils/fixSubmissionIndex.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../..env') });
const mongoose = require('mongoose');
const Submission = require('../models/SubmissionModel');

const INDEXES = [
  {
    name: 'formId_1_userId_1',
    matches: index =>
      index?.unique === true &&
      index.partialFilterExpression?.userId?.$type === 'objectId'
  },
  {
    name: 'formId_1_registrantEmail_1',
    matches: index =>
      index?.unique === true &&
      index.partialFilterExpression?.userId?.$type === 'null'
  }
];

async function findDuplicate(filter, groupBy) {
  const [duplicate] = await Submission.aggregate([
    { $match: filter },
    { $group: { _id: groupBy, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 1 }
  ]);
  return duplicate;
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('connected:', mongoose.connection.name);

  const duplicateMember = await findDuplicate(
      { userId: { $type: 'objectId' } },
      { formId: '$formId', userId: '$userId' }
  );
  const duplicateGuest = await findDuplicate(
      { userId: null },
      { formId: '$formId', email: '$registrantEmail' }
  );
  if (duplicateMember || duplicateGuest) {
    throw new Error(
        'Duplicate submissions exist. Resolve them before repairing unique indexes.'
    );
  }

  await Submission.updateMany(
      { userId: { $exists: false } },
      { $set: { userId: null } }
  );

  const existingIndexes = await Submission.collection.indexes();
  for (const definition of INDEXES) {
    const existing = existingIndexes.find(index => index.name === definition.name);
    if (definition.matches(existing)) continue;
    if (existing) {
      await Submission.collection.dropIndex(definition.name);
    }
  }

  await Submission.createIndexes();
  const repairedIndexes = await Submission.collection.indexes();
  for (const definition of INDEXES) {
    const repaired = repairedIndexes.find(index => index.name === definition.name);
    if (!definition.matches(repaired)) {
      throw new Error(`Index ${definition.name} does not match the submission schema.`);
    }
    console.log(`Repaired ${definition.name}:`, JSON.stringify(repaired));
  }

  await mongoose.disconnect();
})().catch(async error => {
  console.error('submission index repair failed:', error);
  await mongoose.disconnect();
  process.exit(1);
});
