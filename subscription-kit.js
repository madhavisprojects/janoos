// ═══════════════════════════════════════════════════
// SUBSCRIPTION KIT — reusable monthly-subscription billing
//
// Self-contained module: copy this single file into any app
// and call mountSubscriptionKit() with that app's own tenant
// model + auth middleware. No shared package, no cross-repo
// dependency — every app owns its own copy.
//
// This copy is adapted for Janoos: the tenant (User) is looked
// up by its custom `userId` field (from the JWT payload), not
// Mongo `_id`, via resolveTenantId(req). Uses a dedicated
// `subscriptionActive` field rather than the app's existing
// `isActive` (which already means "manually deactivated by
// admin" and already gates login) — keeping them separate
// avoids a login lockout when a subscription lapses.
//
// Pattern mirrors this app's existing UTR-based order-payment
// flow: tenant submits a UPI UTR, admin verifies it,
// verification pushes the due date forward and reactivates
// the tenant.
// ═══════════════════════════════════════════════════

const mongoose = require('mongoose');

function getSubscriptionPaymentModel(tenantModelName) {
  const modelName = `${tenantModelName}SubscriptionPayment`;
  if (mongoose.models[modelName]) return mongoose.models[modelName];
  const schema = new mongoose.Schema({
    tenantId:        { type: mongoose.Schema.Types.ObjectId, ref: tenantModelName, required: true },
    amount:          { type: Number, required: true },
    monthsCovered:   { type: Number, default: 1 },
    utr:             { type: String, required: true },
    upiApp:          { type: String, default: 'UPI' },
    status:          { type: String, default: 'Pending' }, // Pending | Verified | Rejected
    createdDate:     { type: Date, default: Date.now },
    lastUpdatedDate: { type: Date, default: Date.now }
  });
  return mongoose.model(modelName, schema);
}

/**
 * Mounts subscription-renewal routes + returns enforcement helpers.
 *
 * @param app                 Express app
 * @param opts.TenantModel    Mongoose model being billed (e.g. User)
 * @param opts.tenantModelName  String name passed to mongoose.model() for TenantModel (e.g. 'JanoosUser')
 * @param opts.authTenant     Auth middleware for the paying tenant's own login
 * @param opts.resolveTenantId  (req) => Mongoose findOne query identifying the tenant, e.g. req => ({ userId: req.user.userId })
 * @param opts.authAdmin      Auth middleware for the platform admin
 * @param opts.upi            { id, payeeName, qrCode } — or an async fn returning that shape — platform's own UPI details tenants pay into
 * @param opts.fields          Override tenant field names: { amount, due, active, history }
 * @param opts.basePaths       Override route prefixes: { tenant, admin }
 * @param opts.graceDays       Days past due before a tenant is treated as expired (default 0)
 */
function mountSubscriptionKit(app, opts) {
  const {
    TenantModel,
    tenantModelName,
    authTenant,
    resolveTenantId,
    authAdmin,
    upi,
    fields = {},
    basePaths = {},
    graceDays = 0
  } = opts;

  const F = Object.assign({ amount: 'subscriptionAmount', due: 'subscriptionDue', active: 'subscriptionActive', history: 'subscriptionHistory' }, fields);
  const P = Object.assign({ tenant: '/api/subscription', admin: '/api/admin/subscriptions' }, basePaths);
  const SubscriptionPayment = getSubscriptionPaymentModel(tenantModelName);
  const graceMs = graceDays * 24 * 60 * 60 * 1000;

  function isOverdue(tenant) {
    const due = tenant[F.due];
    return !!due && (Date.now() - new Date(due).getTime()) > graceMs;
  }

  // Tenant: view own subscription status + platform UPI details to pay into
  app.get(P.tenant, authTenant, async (req, res) => {
    const tenant = await TenantModel.findOne(resolveTenantId(req)).select(`${F.amount} ${F.due} ${F.active}`);
    if (!tenant) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({
      success: true,
      amount: tenant[F.amount] || 0,
      dueDate: tenant[F.due] || null,
      isActive: tenant[F.active] !== false,
      overdue: isOverdue(tenant),
      upi: typeof upi === 'function' ? await upi() : upi
    });
  });

  // Tenant: submit UTR after paying the platform via UPI
  app.post(`${P.tenant}/pay`, authTenant, async (req, res) => {
    const { utr, upiApp, monthsCovered } = req.body;
    if (!utr) return res.status(400).json({ success: false, error: 'UTR number is required' });
    const tenant = await TenantModel.findOne(resolveTenantId(req)).select(F.amount);
    if (!tenant) return res.status(404).json({ success: false, error: 'Not found' });
    const payment = await SubscriptionPayment.create({
      tenantId: tenant._id,
      amount: tenant[F.amount] || 0,
      monthsCovered: monthsCovered > 0 ? monthsCovered : 1,
      utr, upiApp: upiApp || 'UPI'
    });
    res.json({ success: true, message: 'Payment submitted for verification', payment });
  });

  // Tenant: check status of own submitted payments
  app.get(`${P.tenant}/payments`, authTenant, async (req, res) => {
    const tenant = await TenantModel.findOne(resolveTenantId(req)).select('_id');
    if (!tenant) return res.status(404).json({ success: false, error: 'Not found' });
    const payments = await SubscriptionPayment.find({ tenantId: tenant._id }).sort({ createdDate: -1 });
    res.json({ success: true, payments });
  });

  // Admin: list subscription payments awaiting verification (or by status)
  app.get(P.admin, authAdmin, async (req, res) => {
    const status = req.query.status || 'Pending';
    const filter = status === 'All' ? {} : { status };
    const payments = await SubscriptionPayment.find(filter).populate('tenantId', 'name mobile userId').sort({ createdDate: -1 });
    res.json({ success: true, payments });
  });

  // Admin: verify or reject a submitted payment
  app.patch(`${P.admin}/:id/verify`, authAdmin, async (req, res) => {
    const { status } = req.body; // Verified | Rejected
    if (!['Verified', 'Rejected'].includes(status)) return res.status(400).json({ success: false, error: 'status must be Verified or Rejected' });
    const payment = await SubscriptionPayment.findById(req.params.id);
    if (!payment) return res.status(404).json({ success: false, error: 'Payment not found' });
    if (payment.status !== 'Pending') return res.status(409).json({ success: false, error: `Payment already ${payment.status}` });
    payment.status = status;
    payment.lastUpdatedDate = new Date();
    await payment.save();

    let tenant = null;
    if (status === 'Verified') {
      tenant = await TenantModel.findById(payment.tenantId);
      if (tenant) {
        const base = tenant[F.due] && new Date(tenant[F.due]) > new Date() ? new Date(tenant[F.due]) : new Date();
        base.setMonth(base.getMonth() + payment.monthsCovered);
        tenant[F.due] = base;
        tenant[F.active] = true;
        if (Array.isArray(tenant[F.history])) {
          tenant[F.history].push({ amount: payment.amount, dueDate: base, note: `Renewed via UTR ${payment.utr}` });
        }
        await tenant.save();
      }
    }
    res.json({ success: true, message: `Payment ${status}`, payment, tenant });
  });

  // Middleware: protect tenant routes behind an active subscription
  async function requireActiveSubscription(req, res, next) {
    try {
      const tenant = await TenantModel.findOne(resolveTenantId(req)).select(`${F.due} ${F.active}`);
      if (!tenant) return res.status(404).json({ success: false, error: 'Not found' });
      if (tenant[F.active] === false || isOverdue(tenant)) {
        return res.status(402).json({ success: false, error: 'Subscription expired. Please renew to continue.', code: 'SUBSCRIPTION_EXPIRED' });
      }
      next();
    } catch (e) { next(e); }
  }

  // Sweep: deactivate tenants whose due date has passed (call on a daily timer)
  async function deactivateOverdue() {
    const cutoff = new Date(Date.now() - graceMs);
    const result = await TenantModel.updateMany(
      { [F.due]: { $lt: cutoff }, [F.active]: { $ne: false } },
      { $set: { [F.active]: false } }
    );
    return result.modifiedCount || 0;
  }

  return { requireActiveSubscription, deactivateOverdue, SubscriptionPayment };
}

module.exports = { mountSubscriptionKit };
