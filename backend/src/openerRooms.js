/** One AI opener per chat room — first claim wins. */
const used = new Set();

function tryClaim(roomId) {
  if (!roomId) return false;
  if (used.has(roomId)) return false;
  used.add(roomId);
  return true;
}

function isUsed(roomId) {
  return roomId ? used.has(roomId) : false;
}

module.exports = { tryClaim, isUsed };
