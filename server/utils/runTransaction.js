const mongoose = require('mongoose');

const TRANSACTION_TOPOLOGIES = new Set([
  'ReplicaSetWithPrimary',
  'Sharded',
  'LoadBalanced'
]);

async function runWithOptionalTransaction(work) {
  const topology = mongoose.connection.client?.topology?.description?.type;
  if (!TRANSACTION_TOPOLOGIES.has(topology)) {
    return work(null);
  }

  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(() => work(session));
  } finally {
    await session.endSession();
  }
}

module.exports = { runWithOptionalTransaction };
