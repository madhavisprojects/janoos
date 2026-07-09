require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const session = require("express-session");
const cors = require("cors");
const multer = require("multer");
const multerS3 = require("multer-s3");
const { S3Client, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const axios = require("axios");
const path = require("path");
const { mountSubscriptionKit } = require("./subscription-kit");

const http = require("http");

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 5000;

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "janoos-secret",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 },
  })
);

// ─── MongoDB ───────────────────────────────────────────────────────────────────
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB error:", err));

// ─── AWS S3 ────────────────────────────────────────────────────────────────────
const s3 = new S3Client({
  region: process.env.AWS_REGION || "eu-north-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.AWS_S3_BUCKET || "prochat-images";

const upload = multer({
  storage: multerS3({
    s3,
    bucket: BUCKET,
    key: (req, file, cb) => {
      const folder = req.query.folder || "janoos/orders";
      const filename = `${folder}/${Date.now()}-${file.originalname.replace(/\s+/g, "-")}`;
      cb(null, filename);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are allowed"));
  },
});

// ─── Schemas ───────────────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  userId: { type: String, unique: true },
  name: { type: String, required: true },
  mobile: { type: String, required: true, unique: true },
  email: { type: String },
  address: { type: String },
  gender: { type: String, enum: ["Men", "Women"], default: "Women" },
  password: { type: String, required: true },
  upiId: { type: String },
  utr: { type: String, required: true },
  paymentStatus: { type: String, enum: ["pending", "verified", "rejected"], default: "pending" },
  profileImage: { type: String, default: "" },
  isActive: { type: Boolean, default: true },
  measurements: {
    chest: String,
    waist: String,
    hip: String,
    shoulder: String,
    collar: String,
    sleeveLength: String,
    length: String,
    neck: String,
    bicep: String,
    inseam: String,
    other: String,
  },
  regDate: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  // Monthly subscription (separate from the one-time registration fee above,
  // and separate from `isActive` which is the admin's manual deactivate toggle)
  subscriptionAmount : { type: Number, default: () => Number(process.env.MEMBER_MONTHLY_FEE) || 0 },
  subscriptionDue     : { type: Date, default: () => { const d = new Date(); d.setMonth(d.getMonth() + 1); return d; } },
  subscriptionActive  : { type: Boolean, default: true },
  subscriptionHistory : [{
    amount:    Number,
    dueDate:   Date,
    note:      String,
    changedAt: { type: Date, default: Date.now }
  }]
});

const orderSchema = new mongoose.Schema({
  orderId: { type: String, unique: true },
  userId: { type: String, required: true },
  userName: { type: String },
  userMobile: { type: String },
  description: { type: String, required: true },
  gender: { type: String, enum: ["Women", "Men"], default: "Women" },
  category: {
    type: String,
    enum: ["Blouse", "Salwar Kameez", "Lehenga", "Kurti", "Saree Blouse", "Churidar", "Anarkali", "Shirt", "Kurta Pyjama", "Trousers", "Other"],
    required: true,
  },
  designerId: { type: mongoose.Schema.Types.ObjectId, ref: "JanoosDesigner", default: null },
  referenceImages: [{ type: String }],
  measurements: {
    chest: String,
    waist: String,
    hip: String,
    shoulder: String,
    collar: String,
    sleeveLength: String,
    length: String,
    neck: String,
    bicep: String,
    inseam: String,
    other: String,
  },
  fabric: { type: String },
  colour: { type: String },
  urgency: { type: String, enum: ["Standard (7-10 days)", "Express (3-5 days)", "Urgent (1-2 days)"], default: "Standard (7-10 days)" },
  specialInstructions: { type: String },
  shopVideoUrl: { type: String, default: "" },
  designerStyleVideoUrl: { type: String, default: "" },
  customerStyleVideoUrl: { type: String, default: "" },
  movieStyleVideoUrl: { type: String, default: "" },
  advanceUtr: { type: String, default: "" },
  advanceAmount: { type: Number, default: 0 },
  advanceStatus: { type: String, enum: ["pending", "verified", "rejected"], default: "pending" },
  remainingUtr: { type: String, default: "" },
  remainingAmount: { type: Number, default: 0 },
  remainingStatus: { type: String, enum: ["pending", "verified", "rejected", "not_required"], default: "not_required" },
  status: {
    type: String,
    enum: ["Received", "Measuring", "Cutting", "Stitching", "Quality Check", "Ready", "Delivered"],
    default: "Received",
  },
  estimatedDelivery: { type: Date },
  price: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const adminSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ["super", "staff"], default: "staff" },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const videoSchema = new mongoose.Schema({
  title:       { type: String, required: true },
  gender:      { type: String, enum: ["Women", "Men"], default: "Women" },
  category:    { type: String, required: true },
  videoUrl:    { type: String, required: true },
  description: { type: String, default: "" },
  isActive:    { type: Boolean, default: true },
  designerId:  { type: mongoose.Schema.Types.ObjectId, ref: "JanoosDesigner", default: null },
  createdAt:   { type: Date, default: Date.now },
  updatedAt:   { type: Date, default: Date.now },
});

const designerSchema = new mongoose.Schema({
  name:      { type: String, required: true },
  email:     { type: String, required: true, unique: true },
  mobile:    { type: String, default: "" },
  city:      { type: String, default: "" },
  address:   { type: String, default: "" },
  password:  { type: String, required: true },
  isActive:  { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const settingsSchema = new mongoose.Schema({
  key:   { type: String, unique: true, required: true },
  value: { type: mongoose.Schema.Types.Mixed },
});

const shopVideoSchema = new mongoose.Schema({
  title:          { type: String, required: true },
  videoUrl:       { type: String, required: true },
  shopWhatsappNo: { type: String, default: "" },
  description:    { type: String, default: "" },
  isActive:       { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const Settings   = mongoose.model("JanoosSettings",  settingsSchema);
const User       = mongoose.model("JanoosUser",      userSchema);
const Order      = mongoose.model("JanoosOrder",     orderSchema);
const Admin      = mongoose.model("JanoosAdmin",     adminSchema);
const Video      = mongoose.model("JanoosVideo",     videoSchema);
const ShopVideo  = mongoose.model("JanoosShopVideo", shopVideoSchema);
const Designer   = mongoose.model("JanoosDesigner",  designerSchema);

// ─── Seed super admin ──────────────────────────────────────────────────────────
async function seedAdmin() {
  const exists = await Admin.findOne({ username: process.env.SUPER_ADMIN_USERNAME || "janoos_admin" });
  if (!exists) {
    const hashed = await bcrypt.hash(process.env.SUPER_ADMIN_PASSWORD || "janoos@123", 10);
    await Admin.create({
      username: process.env.SUPER_ADMIN_USERNAME || "janoos_admin",
      password: hashed,
      role: "super",
    });
    console.log("Super admin seeded");
  }
}
mongoose.connection.once("open", seedAdmin);

// ─── Auth Middleware ───────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || "janoos-jwt-secret";

function authUser(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Unauthorised" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

function authAdmin(req, res, next) {
  if (!req.session.admin) return res.status(401).json({ error: "Admin not logged in" });
  next();
}

function requireSuperRole(req, res, next) {
  if (!req.session.admin || req.session.admin.role !== "super")
    return res.status(403).json({ success: false, error: "Only super admins can manage admin accounts" });
  next();
}

// ─── Subscription Kit — members pay a recurring monthly fee ───────────────────
// (separate from the one-time registration fee above)
const { requireActiveSubscription, deactivateOverdue } = mountSubscriptionKit(app, {
  TenantModel: User,
  tenantModelName: "JanoosUser",
  authTenant: authUser,
  resolveTenantId: req => ({ userId: req.user.userId }),
  authAdmin,
  upi: async () => ({
    id: await getSetting("subscriptionUpiId", process.env.PLATFORM_UPI_ID || "9989336847@ybl"),
    payeeName: await getSetting("subscriptionPayeeName", process.env.PLATFORM_UPI_NAME || "Janoos"),
    qrCode: await getSetting("subscriptionQrCode", "")
  }),
  graceDays: 3
});
deactivateOverdue().catch(err => console.error("Subscription sweep error:", err));
setInterval(() => deactivateOverdue().catch(err => console.error("Subscription sweep error:", err)), 24 * 60 * 60 * 1000);

// ─── OTP Store (in-memory) ────────────────────────────────────────────────────
const otpStore = new Map();

async function sendOtp(mobile, otp) {
  const r = await axios.get("https://www.fast2sms.com/dev/bulkV2", {
    params: {
      authorization: process.env.FAST2SMS_API_KEY,
      route: "otp",
      variables_values: otp,
      flash: 0,
      numbers: mobile,
    },
  });
  if (!r.data.return) throw new Error(r.data.message || "Failed to send OTP");
}

// ═══════════════════════════════════════════════════════════════════════════════
// USER ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// Register
app.post("/api/register", async (req, res) => {
  try {
    const { name, mobile, email, address, password, upiId, utr, gender } = req.body;
    if (!name || !mobile || !password || !utr)
      return res.status(400).json({ error: "Name, mobile, password and UTR are required" });

    const exists = await User.findOne({ mobile });
    if (exists) return res.status(400).json({ error: "Mobile number already registered" });

    const hashed = await bcrypt.hash(password, 10);
    const userId = "JAN" + Date.now();
    const user = await User.create({ userId, name, mobile, email, address, password: hashed, upiId, utr, gender: gender || "Women" });

    const token = jwt.sign({ userId: user.userId, mobile: user.mobile }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ success: true, token, user: { userId: user.userId, name: user.name, mobile: user.mobile, paymentStatus: user.paymentStatus } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login
app.post("/api/login", async (req, res) => {
  try {
    const { mobile, password } = req.body;
    const user = await User.findOne({ mobile });
    if (!user) return res.status(400).json({ error: "Mobile number not found" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: "Incorrect password" });

    if (!user.isActive) return res.status(403).json({ error: "Account is deactivated. Contact support." });

    if ((user.paymentStatus || 'pending') !== 'verified')
      return res.status(403).json({ error: "PAYMENT_PENDING" });

    const token = jwt.sign({ userId: user.userId, mobile: user.mobile }, JWT_SECRET, { expiresIn: "7d" });
    res.json({
      success: true, token,
      user: { userId: user.userId, name: user.name, mobile: user.mobile, profileImage: user.profileImage, paymentStatus: user.paymentStatus },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get my profile
app.get("/api/me", authUser, async (req, res) => {
  try {
    const user = await User.findOne({ userId: req.user.userId }).select("-password -utr");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update profile
app.put("/api/me", authUser, async (req, res) => {
  try {
    const updates = {};
    const allowed = ["name", "email", "address", "profileImage", "upiId"];
    allowed.forEach((f) => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
    const user = await User.findOneAndUpdate({ userId: req.user.userId }, updates, { new: true }).select("-password -utr");
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Forgot password
app.post("/api/forgot-password", async (req, res) => {
  try {
    const { mobile } = req.body;
    const user = await User.findOne({ mobile });
    if (!user) return res.status(404).json({ error: "Mobile number not registered" });
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore.set(mobile, { otp, expiry: Date.now() + 10 * 60 * 1000 });
    await sendOtp(mobile, otp);
    res.json({ success: true, message: "OTP sent to your mobile number" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reset password
app.post("/api/reset-password", async (req, res) => {
  try {
    const { mobile, otp, newPassword } = req.body;
    const record = otpStore.get(mobile);
    if (!record) return res.status(400).json({ error: "OTP not found. Please request again." });
    if (Date.now() > record.expiry) { otpStore.delete(mobile); return res.status(400).json({ error: "OTP expired" }); }
    if (record.otp !== otp) return res.status(400).json({ error: "Invalid OTP" });
    const hashed = await bcrypt.hash(newPassword, 10);
    await User.findOneAndUpdate({ mobile }, { password: hashed });
    otpStore.delete(mobile);
    res.json({ success: true, message: "Password reset successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Orders ────────────────────────────────────────────────────────────────────

// Place order
app.post("/api/orders", authUser, requireActiveSubscription, async (req, res) => {
  try {
    const { description, category, gender, designerId, measurements, fabric, colour, urgency, specialInstructions, referenceImages, shopVideoUrl, designerStyleVideoUrl, customerStyleVideoUrl, movieStyleVideoUrl, advanceUtr, advanceAmount } = req.body;
    if (!description || !category) return res.status(400).json({ error: "Description and category are required" });
    if (!advanceUtr) return res.status(400).json({ error: "Advance payment UTR is required" });

    const user = await User.findOne({ userId: req.user.userId });
    const orderId = "ORD" + Date.now();
    const order = await Order.create({
      orderId, userId: req.user.userId,
      userName: user.name, userMobile: user.mobile,
      description, category, gender: gender || "Women", designerId: designerId || null, measurements: measurements || {},
      fabric, colour, urgency, specialInstructions,
      referenceImages: referenceImages || [],
      shopVideoUrl: shopVideoUrl || "",
      designerStyleVideoUrl: designerStyleVideoUrl || "",
      customerStyleVideoUrl: customerStyleVideoUrl || "",
      movieStyleVideoUrl: movieStyleVideoUrl || "",
      advanceUtr, advanceAmount: advanceAmount || 0, advanceStatus: "pending",
    });
    if (measurements && Object.keys(measurements).length) {
      await User.updateOne({ userId: req.user.userId }, { measurements, updatedAt: new Date() });
    }
    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Submit remaining payment UTR
app.post("/api/orders/:orderId/remaining-payment", authUser, async (req, res) => {
  try {
    const { remainingUtr } = req.body;
    if (!remainingUtr) return res.status(400).json({ error: "UTR is required" });
    const order = await Order.findOne({ orderId: req.params.orderId, userId: req.user.userId });
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.status !== "Ready") return res.status(400).json({ error: "Order is not ready for final payment" });
    const remainingAmount = Math.max(0, (order.price || 0) - (order.advanceAmount || 0));
    await Order.findOneAndUpdate(
      { orderId: req.params.orderId },
      { remainingUtr, remainingAmount, remainingStatus: "pending" }
    );
    res.json({ success: true, message: "Remaining payment submitted. Admin will verify shortly." });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get my orders
app.get("/api/orders/my", authUser, async (req, res) => {
  try {
    const orders = await Order.find({ userId: req.user.userId }).sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single order
app.get("/api/orders/:orderId", authUser, async (req, res) => {
  try {
    const order = await Order.findOne({ orderId: req.params.orderId, userId: req.user.userId });
    if (!order) return res.status(404).json({ error: "Order not found" });
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Image upload ──────────────────────────────────────────────────────────────
app.post("/api/upload", upload.array("images", 5), (req, res) => {
  const urls = req.files.map((f) => f.location);
  res.json({ success: true, urls });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// Admin login
app.post("/api/admin/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const admin = await Admin.findOne({ username });
    if (!admin) return res.status(401).json({ error: "Invalid credentials" });
    const match = await bcrypt.compare(password, admin.password);
    if (!match) return res.status(401).json({ error: "Invalid credentials" });
    req.session.admin = { username: admin.username, role: admin.role };
    res.json({ success: true, admin: { username: admin.username, role: admin.role } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin logout
app.post("/api/admin/logout", (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ─── Super admin: manage designers ──────────────────────────────────────────────
app.get("/api/admin/designers", authAdmin, async (req, res) => {
  try {
    const designers = await Designer.find().sort({ createdAt: -1 }).select("-password");
    res.json({ success: true, data: designers });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post("/api/admin/designers", authAdmin, async (req, res) => {
  try {
    const { name, email, mobile, city, address, password } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ success: false, error: "name, email and password are required" });
    const hashed = await bcrypt.hash(password, 10);
    const designer = await Designer.create({ name, email, mobile: mobile || "", city: city || "", address: address || "", password: hashed });
    const { password: _pw, ...safe } = designer.toObject();
    res.status(201).json({ success: true, data: safe });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.patch("/api/admin/designers/:id", authAdmin, async (req, res) => {
  try {
    const update = { ...req.body, updatedAt: new Date() };
    if (update.password) update.password = await bcrypt.hash(update.password, 10);
    else delete update.password;
    const designer = await Designer.findByIdAndUpdate(req.params.id, update, { new: true }).select("-password");
    if (!designer) return res.status(404).json({ success: false, error: "Designer not found" });
    res.json({ success: true, data: designer });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete("/api/admin/designers/:id", authAdmin, async (req, res) => {
  try {
    await Designer.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Designer deleted" });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── Super admin: manage admin accounts ─────────────────────────────────────────
app.get("/api/admin/admins", authAdmin, requireSuperRole, async (req, res) => {
  try {
    const admins = await Admin.find().sort({ createdAt: -1 }).select("-password");
    res.json({ success: true, data: admins });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post("/api/admin/admins", authAdmin, requireSuperRole, async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, error: "username and password are required" });
    if (!["super", "staff"].includes(role)) return res.status(400).json({ success: false, error: "role must be super or staff" });
    const exists = await Admin.findOne({ username });
    if (exists) return res.status(409).json({ success: false, error: "Username already taken" });
    const hashed = await bcrypt.hash(password, 10);
    const admin = await Admin.create({ username, password: hashed, role });
    const { password: _pw, ...safe } = admin.toObject();
    res.status(201).json({ success: true, data: safe });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.patch("/api/admin/admins/:id", authAdmin, requireSuperRole, async (req, res) => {
  try {
    const { username, password, role } = req.body;
    const update = { updatedAt: new Date() };
    if (username) {
      const exists = await Admin.findOne({ username, _id: { $ne: req.params.id } });
      if (exists) return res.status(409).json({ success: false, error: "Username already taken" });
      update.username = username;
    }
    if (role) {
      if (!["super", "staff"].includes(role)) return res.status(400).json({ success: false, error: "role must be super or staff" });
      update.role = role;
    }
    if (password) update.password = await bcrypt.hash(password, 10);
    const admin = await Admin.findByIdAndUpdate(req.params.id, update, { new: true }).select("-password");
    if (!admin) return res.status(404).json({ success: false, error: "Admin not found" });
    res.json({ success: true, data: admin });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete("/api/admin/admins/:id", authAdmin, requireSuperRole, async (req, res) => {
  try {
    const target = await Admin.findById(req.params.id);
    if (!target) return res.status(404).json({ success: false, error: "Admin not found" });
    if (target.username === req.session.admin.username)
      return res.status(400).json({ success: false, error: "You cannot delete your own account" });
    if (target.role === "super") {
      const superCount = await Admin.countDocuments({ role: "super" });
      if (superCount <= 1) return res.status(400).json({ success: false, error: "Cannot delete the last super admin" });
    }
    await Admin.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Admin deleted" });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Admin stats
app.get("/api/admin/stats", authAdmin, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const pendingPayments = await User.countDocuments({ paymentStatus: "pending" });
    const verifiedUsers = await User.countDocuments({ paymentStatus: "verified" });
    const totalOrders = await Order.countDocuments();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const newToday = await User.countDocuments({ regDate: { $gte: today } });
    const ordersToday = await Order.countDocuments({ createdAt: { $gte: today } });

    const ordersByStatus = await Order.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);

    res.json({ totalUsers, pendingPayments, verifiedUsers, totalOrders, newToday, ordersToday, ordersByStatus });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all users
app.get("/api/admin/users", authAdmin, async (req, res) => {
  try {
    const { search, paymentStatus, gender } = req.query;
    const query = {};
    if (search) query.$or = [
      { name: new RegExp(search, "i") },
      { mobile: new RegExp(search, "i") },
      { userId: new RegExp(search, "i") },
    ];
    if (paymentStatus) query.paymentStatus = paymentStatus;
    if (gender === "Women") query.$and = [{ $or: [{ gender: "Women" }, { gender: { $exists: false } }, { gender: null }] }];
    else if (gender) query.gender = gender;
    const users = await User.find(query).select("-password").sort({ regDate: -1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single user's full profile
app.get("/api/admin/users/:userId", authAdmin, async (req, res) => {
  try {
    const user = await User.findOne({ userId: req.params.userId }).select("-password");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update user profile + measurements (admin)
app.put("/api/admin/users/:userId/profile", authAdmin, async (req, res) => {
  try {
    const { name, email, address, upiId, gender, measurements, password } = req.body;
    const update = { updatedAt: new Date() };
    if (name !== undefined) update.name = name;
    if (email !== undefined) update.email = email;
    if (address !== undefined) update.address = address;
    if (upiId !== undefined) update.upiId = upiId;
    if (gender !== undefined) update.gender = gender;
    if (measurements !== undefined) update.measurements = measurements;
    if (password) update.password = await bcrypt.hash(password, 10);
    const user = await User.findOneAndUpdate({ userId: req.params.userId }, update, { new: true }).select("-password");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify / reject payment
app.put("/api/admin/users/:userId/payment", authAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    if (!["verified", "rejected", "pending"].includes(status))
      return res.status(400).json({ error: "Invalid status" });
    const user = await User.findOneAndUpdate({ userId: req.params.userId }, { paymentStatus: status, updatedAt: new Date() }, { new: true }).select("-password");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update a member's subscription amount / due date (per-member, like UrShop's per-shop pricing)
app.patch("/api/admin/users/:userId/subscription", authAdmin, async (req, res) => {
  try {
    const { subscriptionAmount, subscriptionDue, note } = req.body;
    const update = {};
    if (subscriptionAmount !== undefined) update.subscriptionAmount = subscriptionAmount;
    if (subscriptionDue)                  update.subscriptionDue    = new Date(subscriptionDue);
    if (subscriptionAmount !== undefined || subscriptionDue || note) {
      update.$push = { subscriptionHistory: {
        amount:  subscriptionAmount,
        dueDate: subscriptionDue ? new Date(subscriptionDue) : undefined,
        note:    note || ""
      } };
    }
    const user = await User.findOneAndUpdate({ userId: req.params.userId }, update, { new: true }).select("-password");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete user
app.delete("/api/admin/users/:userId", authAdmin, async (req, res) => {
  try {
    await User.findOneAndDelete({ userId: req.params.userId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all orders
app.get("/api/admin/orders", authAdmin, async (req, res) => {
  try {
    const { search, status, userId } = req.query;
    const query = {};
    if (search) query.$or = [
      { orderId: new RegExp(search, "i") },
      { userName: new RegExp(search, "i") },
      { userMobile: new RegExp(search, "i") },
    ];
    if (status) query.status = status;
    if (userId) query.userId = userId;
    const orders = await Order.find(query).sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update order status + price + delivery date
app.put("/api/admin/orders/:orderId", authAdmin, async (req, res) => {
  try {
    const { status, price, estimatedDelivery } = req.body;
    const updates = { updatedAt: new Date() };
    if (status) updates.status = status;
    if (price !== undefined) updates.price = Number(price);
    if (estimatedDelivery) updates.estimatedDelivery = new Date(estimatedDelivery);
    // When price is set and order becomes Ready, open remaining payment collection
    if (status === "Ready" && price !== undefined) updates.remainingStatus = "pending";
    const order = await Order.findOneAndUpdate({ orderId: req.params.orderId }, updates, { new: true });
    if (!order) return res.status(404).json({ error: "Order not found" });
    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: verify/reject advance or remaining payment
app.patch("/api/admin/orders/:orderId/payment", authAdmin, async (req, res) => {
  try {
    const { type, status } = req.body; // type: "advance" | "remaining", status: "verified"|"rejected"
    if (!["advance","remaining"].includes(type) || !["verified","rejected"].includes(status))
      return res.status(400).json({ error: "Invalid type or status" });
    const field = type === "advance" ? "advanceStatus" : "remainingStatus";
    const order = await Order.findOneAndUpdate(
      { orderId: req.params.orderId },
      { [field]: status, updatedAt: new Date() },
      { new: true }
    );
    if (!order) return res.status(404).json({ error: "Order not found" });
    res.json({ success: true, order });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: sales revenue stats (current month trend + today/month totals)
function orderRevenue(o) {
  let rev = 0;
  if (o.advanceStatus === "verified")   rev += o.advanceAmount   || 0;
  if (o.remainingStatus === "verified") rev += o.remainingAmount || 0;
  return rev;
}

app.get("/api/admin/sales-stats", authAdmin, async (req, res) => {
  try {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const monthOrders = await Order.find({ createdAt: { $gte: startOfMonth } });

    let todaySales = 0, monthSales = 0;
    const dailyMap = {};

    monthOrders.forEach(o => {
      const revenue = orderRevenue(o);
      monthSales += revenue;
      if (o.createdAt >= startOfToday) todaySales += revenue;
      const day = o.createdAt.getDate();
      dailyMap[day] = (dailyMap[day] || 0) + revenue;
    });

    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const dailyBreakdown = Array.from({ length: daysInMonth }, (_, i) => {
      const day = i + 1;
      return { day, sales: dailyMap[day] || 0 };
    });

    res.json({ todaySales, monthSales, dailyBreakdown });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/admin/sales-range", authAdmin, async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: "from and to dates are required (YYYY-MM-DD)" });

    const fromDate = new Date(from + "T00:00:00");
    const toDate   = new Date(to   + "T23:59:59.999");
    if (isNaN(fromDate) || isNaN(toDate) || fromDate > toDate)
      return res.status(400).json({ error: "Invalid date range" });

    const orders = await Order.find({ createdAt: { $gte: fromDate, $lte: toDate } }).sort({ createdAt: 1 });

    let totalSales = 0;
    const dailyMap = {};
    orders.forEach(o => {
      const revenue = orderRevenue(o);
      totalSales += revenue;
      const key = o.createdAt.toISOString().split("T")[0];
      dailyMap[key] = (dailyMap[key] || 0) + revenue;
    });

    const dailyBreakdown = Object.keys(dailyMap).sort().map(date => ({ date, sales: dailyMap[date] }));

    res.json({ totalSales, orderCount: orders.length, dailyBreakdown });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: get shop settings
app.get("/api/admin/settings", authAdmin, async (req, res) => {
  try {
    const upiId         = await getSetting("orderUpiId",         "9989336847@ybl");
    const payeeName     = await getSetting("orderPayeeName",     "Janoos Stitching");
    const advanceAmount = await getSetting("orderAdvanceAmount", 200);
    res.json({ success: true, upiId, payeeName, advanceAmount });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Delete order
app.delete("/api/admin/orders/:orderId", authAdmin, async (req, res) => {
  try {
    await Order.findOneAndDelete({ orderId: req.params.orderId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin image upload
app.post("/api/admin/upload", authAdmin, upload.single("image"), (req, res) => {
  res.json({ success: true, url: req.file.location });
});

// Delete image from S3
app.delete("/api/admin/upload", authAdmin, async (req, res) => {
  try {
    const { url } = req.body;
    const key = url.split(".amazonaws.com/")[1];
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Video Routes ──────────────────────────────────────────────────────────────

// Public: get all active videos
app.get("/api/videos", async (req, res) => {
  try {
    const videos = await Video.find({ isActive: true }).sort({ createdAt: -1 });
    res.json({ success: true, data: videos });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Public: get all active designers (for member-facing designer picker)
app.get("/api/designers", async (req, res) => {
  try {
    const designers = await Designer.find({ isActive: true }).sort({ name: 1 }).select("name city mobile");
    res.json({ success: true, data: designers });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Admin: get all videos (including inactive)
app.get("/api/admin/videos", authAdmin, async (req, res) => {
  try {
    const videos = await Video.find().sort({ createdAt: -1 }).populate("designerId", "name");
    res.json({ success: true, data: videos });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Admin: add video
app.post("/api/admin/videos", authAdmin, async (req, res) => {
  try {
    const { title, gender, category, designerId, videoUrl, description } = req.body;
    if (!title || !category || !videoUrl)
      return res.status(400).json({ success: false, error: "title, category and videoUrl are required" });
    const video = await Video.create({ title, gender: gender || "Women", category, designerId: designerId || null, videoUrl, description: description || "" });
    res.status(201).json({ success: true, data: video });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Admin: update video
app.patch("/api/admin/videos/:id", authAdmin, async (req, res) => {
  try {
    const video = await Video.findByIdAndUpdate(req.params.id, { ...req.body, updatedAt: new Date() }, { new: true });
    if (!video) return res.status(404).json({ success: false, error: "Video not found" });
    res.json({ success: true, data: video });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Admin: delete video
app.delete("/api/admin/videos/:id", authAdmin, async (req, res) => {
  try {
    await Video.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Video deleted" });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── Shop Settings ────────────────────────────────────────────────────────────
async function getSetting(key, defaultVal) {
  const s = await Settings.findOne({ key });
  return s ? s.value : defaultVal;
}

// Public: get order payment settings
app.get("/api/settings/order-payment", async (req, res) => {
  try {
    const upiId         = await getSetting("orderUpiId",         "9989336847@ybl");
    const payeeName     = await getSetting("orderPayeeName",     "Janoos Stitching");
    const advanceAmount = await getSetting("orderAdvanceAmount", 200);
    res.json({ success: true, upiId, payeeName, advanceAmount });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Admin: update order payment settings
app.patch("/api/admin/settings/order-payment", authAdmin, async (req, res) => {
  try {
    const { upiId, payeeName, advanceAmount } = req.body;
    if (upiId)         await Settings.findOneAndUpdate({ key: "orderUpiId" },         { value: upiId },         { upsert: true });
    if (payeeName)     await Settings.findOneAndUpdate({ key: "orderPayeeName" },     { value: payeeName },     { upsert: true });
    if (advanceAmount) await Settings.findOneAndUpdate({ key: "orderAdvanceAmount" }, { value: advanceAmount }, { upsert: true });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Admin: get subscription (member monthly renewal) payment settings
app.get("/api/admin/settings/subscription-payment", authAdmin, async (req, res) => {
  try {
    const upiId     = await getSetting("subscriptionUpiId",     process.env.PLATFORM_UPI_ID  || "9989336847@ybl");
    const payeeName = await getSetting("subscriptionPayeeName", process.env.PLATFORM_UPI_NAME || "Janoos");
    const qrCode    = await getSetting("subscriptionQrCode",    "");
    res.json({ success: true, upiId, payeeName, qrCode });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Admin: update subscription (member monthly renewal) payment settings
app.patch("/api/admin/settings/subscription-payment", authAdmin, async (req, res) => {
  try {
    const { upiId, payeeName, qrCode } = req.body;
    if (upiId !== undefined)     await Settings.findOneAndUpdate({ key: "subscriptionUpiId" },     { value: upiId },     { upsert: true });
    if (payeeName !== undefined) await Settings.findOneAndUpdate({ key: "subscriptionPayeeName" }, { value: payeeName }, { upsert: true });
    if (qrCode !== undefined)    await Settings.findOneAndUpdate({ key: "subscriptionQrCode" },    { value: qrCode },    { upsert: true });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── Shop Videos (reference videos for order form) ────────────────────────────
// Public: get active shop videos
app.get("/api/shop-videos", async (req, res) => {
  try {
    const videos = await ShopVideo.find({ isActive: true }).sort({ createdAt: -1 });
    res.json({ success: true, data: videos });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Admin: get all shop videos
app.get("/api/admin/shop-videos", authAdmin, async (req, res) => {
  try {
    const videos = await ShopVideo.find().sort({ createdAt: -1 });
    res.json({ success: true, data: videos });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Admin: add shop video
app.post("/api/admin/shop-videos", authAdmin, async (req, res) => {
  try {
    const { title, videoUrl, shopWhatsappNo, description } = req.body;
    if (!title || !videoUrl) return res.status(400).json({ success: false, error: "title and videoUrl are required" });
    const video = await ShopVideo.create({ title, videoUrl, shopWhatsappNo, description });
    res.status(201).json({ success: true, data: video });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Admin: update shop video
app.patch("/api/admin/shop-videos/:id", authAdmin, async (req, res) => {
  try {
    const video = await ShopVideo.findByIdAndUpdate(req.params.id, { ...req.body, updatedAt: new Date() }, { new: true });
    if (!video) return res.status(404).json({ success: false, error: "Not found" });
    res.json({ success: true, data: video });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Admin: delete shop video
app.delete("/api/admin/shop-videos/:id", authAdmin, async (req, res) => {
  try {
    await ShopVideo.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Deleted" });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── Serve pages ───────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/register", (req, res) => res.sendFile(path.join(__dirname, "public", "register.html")));
app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

server.listen(PORT, () => console.log(`Janoos server running on port ${PORT}`));
