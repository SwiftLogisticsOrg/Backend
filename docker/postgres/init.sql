-- Create databases for different services
CREATE DATABASE swifttrack_users;
CREATE DATABASE swifttrack_logistics;

-- Grant permissions
GRANT ALL PRIVILEGES ON DATABASE swifttrack_users TO swifttrack;
GRANT ALL PRIVILEGES ON DATABASE swifttrack_logistics TO swifttrack;
