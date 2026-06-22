require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/janoos')
  .then(async () => {
    const User  = mongoose.model('JanoosUser',  new mongoose.Schema({}, { strict: false }));
    const Order = mongoose.model('JanoosOrder', new mongoose.Schema({}, { strict: false }));

    // Upsert test member
    const hash = await bcrypt.hash('test@123', 10);
    const user = await User.findOneAndUpdate(
      { mobile: '9876543210' },
      {
        userId: 'JN-TEST01', name: 'Priya Sharma', mobile: '9876543210',
        email: 'priya@test.com', address: '12, Rose Garden, Hyderabad',
        password: hash, utr: 'UTR123456789', upiId: '9876543210@ybl',
        paymentStatus: 'verified', isActive: true, regDate: new Date()
      },
      { upsert: true, new: true }
    );
    console.log('✅ Member:', user.name, '|', user.userId, '| paymentStatus:', user.paymentStatus);

    // Create test order
    const existing = await Order.findOne({ userId: 'JN-TEST01' });
    if (!existing) {
      const order = await Order.create({
        orderId: 'ORD-TEST01', userId: 'JN-TEST01',
        userName: 'Priya Sharma', userMobile: '9876543210',
        description: 'Silk blouse with embroidered border, round neck, full sleeves',
        category: 'Blouse',
        measurements: { chest: '36"', waist: '30"', hip: '38"', shoulder: '14"', sleeveLength: '22"', length: '16"', neck: '14"' },
        fabric: 'Silk', colour: 'Deep Red',
        urgency: 'Express (3-5 days)',
        specialInstructions: 'Zari border on sleeves and neck, lining inside',
        status: 'Stitching', price: 850,
        referenceImages: [],
        createdAt: new Date(), updatedAt: new Date()
      });
      console.log('✅ Order created:', order.orderId, '| Status:', order.status);
    } else {
      console.log('ℹ️  Order already exists:', existing.orderId);
    }

    mongoose.disconnect();
  })
  .catch(e => { console.error(e); process.exit(1); });
