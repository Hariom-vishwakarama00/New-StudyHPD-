-- Razorpay (automatic payments). Additive only: existing rows are untouched.
-- The worker also applies this automatically on its first request, so running it by hand is optional.
-- (If you run it by hand and a column already exists, SQLite reports "duplicate column"; that is safe to ignore.)

ALTER TABLE payments ADD COLUMN method TEXT;               -- NULL/'upi' = manual UPI, 'razorpay' = automatic
ALTER TABLE payments ADD COLUMN gateway_order_id TEXT;     -- Razorpay order_id
ALTER TABLE payments ADD COLUMN gateway_payment_id TEXT;   -- Razorpay payment_id (pay_...)
CREATE UNIQUE INDEX IF NOT EXISTS idx_pay_gw_order ON payments(gateway_order_id);

CREATE TABLE IF NOT EXISTS rzp_orders (order_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, plan_id TEXT, plan_name TEXT, amount INTEGER NOT NULL, amount_paise INTEGER NOT NULL, months INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'created', payment_id TEXT, created_at INTEGER, paid_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_rzp_orders_user ON rzp_orders(user_id);
