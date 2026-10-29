-- OD (on duty) punch: chosen people may punch in and out away from their workplace.
-- The shift waits as 'od_punch' until the OD request made at punch-out is decided.
ALTER TABLE users ADD COLUMN IF NOT EXISTS od_punch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS od_purpose TEXT;
ALTER TABLE regularizations ADD COLUMN IF NOT EXISTS from_punch INTEGER NOT NULL DEFAULT 0;
