// Create database and user for orders service
db = db.getSiblingDB('swifttrack_orders');
db.createUser({
  user: 'swifttrack',
  pwd: 'swifttrack123',
  roles: [{ role: 'readWrite', db: 'swifttrack_orders' }]
});
