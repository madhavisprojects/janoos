// One-off backfill: existing users predate the subscriptionDue/subscriptionAmount/
// subscriptionActive fields, so mongoose's schema defaults (which only apply at
// document creation) never ran for them. Sets subscriptionDue to 1 month from now
// for any user missing it. Safe to re-run — only touches documents that still lack
// the field.
require("dotenv").config();
const mongoose = require("mongoose");

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const dueDate = new Date();
  dueDate.setMonth(dueDate.getMonth() + 1);

  const result = await mongoose.connection.collection("janoosusers").updateMany(
    { subscriptionDue: { $exists: false } },
    {
      $set: {
        subscriptionDue: dueDate,
        subscriptionAmount: Number(process.env.MEMBER_MONTHLY_FEE) || 0,
        subscriptionActive: true,
        subscriptionHistory: []
      }
    }
  );
  console.log(`Backfilled ${result.modifiedCount} user(s). New subscriptionDue: ${dueDate.toISOString()}`);
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
