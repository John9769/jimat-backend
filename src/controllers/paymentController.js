const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const { getChainStatus, getPricing } = require('../engine/chainEngine');

const prisma = new PrismaClient();

// Create ToyyibPay bill + Payment record atomically
const createPayment = async (req, res) => {
  try {
    const { recordId } = req.body;

    if (!recordId) {
      return res.status(400).json({ success: false, message: 'recordId required' });
    }

    // Get billing record
    const record = await prisma.billingRecord.findFirst({
      where: { id: recordId, userId: req.user.id }
    });

    if (!record) {
      return res.status(404).json({ success: false, message: 'Billing record not found' });
    }

    if (record.isUnlocked) {
      return res.status(400).json({ success: false, message: 'Report already unlocked' });
    }

    // Check for existing PENDING payment for this record
    const existingPayment = await prisma.payment.findFirst({
      where: {
        userId: req.user.id,
        status: 'PENDING',
        billingRecords: { some: { id: recordId } }
      }
    });

    if (existingPayment) {
      // Return existing bill code — dont create duplicate
      return res.json({
        success: true,
        billCode: existingPayment.toyyibpayBillCode,
        paymentUrl: `${process.env.TOYYIBPAY_BASE_URL}/${existingPayment.toyyibpayBillCode}`,
        amount: existingPayment.amountMyr
      });
    }

    // Get chain status + pricing
    const chainStatus = await getChainStatus(req.user.id, prisma);
    const pricing = getPricing(req.user.userType, chainStatus.status);

    // Determine ToyyibPay category
    const categoryCode = req.user.userType === 'INSTITUTIONAL'
      ? process.env.TOYYIBPAY_CATEGORY_INSTITUTIONAL
      : process.env.TOYYIBPAY_CATEGORY_HOUSEHOLD;

    // Generate unique billRef
    const billRef = `JIMAT-${req.user.id.slice(-6).toUpperCase()}-${Date.now()}`;

    // Amount in cents for ToyyibPay
    const amountCents = Math.round(pricing.total * 100);

    // Create ToyyibPay bill
    const toyyibPayload = new URLSearchParams({
      userSecretKey: process.env.TOYYIBPAY_API_KEY,
      categoryCode,
      billName: `JIMAT ${chainStatus.status === 'MONTHLY' ? 'Monthly' : 'Onboard'} Analysis`,
      billDescription: `JIMAT electricity bill analysis - ${record.billingMonth}`,
      billPriceSetting: 1,
      billPayorInfo: 1,
      billAmount: amountCents,
      billReturnUrl: `${process.env.FRONTEND_URL}/payment/success`,
      billCallbackUrl: `${process.env.BACKEND_URL || 'https://jimat-backend.onrender.com'}/api/payment/webhook`,
      billExternalReferenceNo: billRef,
      billTo: req.user.name,
      billPhone: req.user.phone || '0123456789',
      billSplitPayment: 0,
      billSplitPaymentArgs: '',
      billPaymentChannel: 0,
      billDisplayMerchant: 1,
      billContentEmail: `Terima kasih kerana menggunakan JIMAT. Laporan analisis bil elektrik anda untuk ${record.billingMonth} sudah bersedia.`,
      billChargeToCustomer: 1,
      enableDuitNowQR: 1,
      chargeDuitNowQR: 0
    });

    const toyyibResponse = await axios.post(
      `${process.env.TOYYIBPAY_BASE_URL}/index.php/api/createBill`,
      toyyibPayload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const billData = toyyibResponse.data;

    if (!billData || !billData[0] || !billData[0].BillCode) {
      console.error('ToyyibPay error:', billData);
      return res.status(500).json({ success: false, message: 'Failed to create payment bill' });
    }

    const billCode = billData[0].BillCode;

    // Save payment record
    const payment = await prisma.payment.create({
      data: {
        userId: req.user.id,
        billRef,
        amountMyr: pricing.total,
        paymentType: chainStatus.status === 'MONTHLY' ? 'MONTHLY' : chainStatus.status === 'RESET' ? 'RESET' : 'ONBOARD',
        status: 'PENDING',
        toyyibpayBillCode: billCode,
        billingRecords: { connect: { id: recordId } }
      }
    });

    res.json({
      success: true,
      billCode,
      paymentUrl: `${process.env.TOYYIBPAY_BASE_URL}/${billCode}`,
      amount: pricing.total,
      paymentId: payment.id
    });
  } catch (error) {
    console.error('Create payment error:', error);
    res.status(500).json({ success: false, message: 'Failed to create payment' });
  }
};

// ToyyibPay webhook — called by ToyyibPay server
const webhook = async (req, res) => {
  try {
    const { billcode, order_id, status, reason } = req.body;

    console.log('ToyyibPay webhook received:', { billcode, order_id, status, reason });

    if (!billcode) {
      return res.status(400).send('Missing billcode');
    }

    // Find payment by bill code
    const payment = await prisma.payment.findFirst({
      where: { toyyibpayBillCode: billcode },
      include: { billingRecords: true }
    });

    if (!payment) {
      console.error('Payment not found for billcode:', billcode);
      return res.status(404).send('Payment not found');
    }

    // Prevent double processing
    if (payment.status === 'SUCCESS') {
      console.log('Payment already processed:', billcode);
      return res.status(200).send('Already processed');
    }

    // status 1 = success, status 2 = pending, status 3 = failed
    if (status === '1') {
      // SUCCESS — unlock report
      await prisma.$transaction(async (tx) => {
        // Update payment status
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: 'SUCCESS',
            toyyibpayOrderId: order_id || null,
            paidAt: new Date()
          }
        });

        // Unlock all billing records linked to this payment
        for (const record of payment.billingRecords) {
          await tx.billingRecord.update({
            where: { id: record.id },
            data: { isUnlocked: true }
          });
        }
      });

      console.log('Payment SUCCESS — report unlocked for billcode:', billcode);
    } else {
      // FAILED
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'FAILED' }
      });

      console.log('Payment FAILED for billcode:', billcode, 'reason:', reason);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('Webhook error');
  }
};

// Check payment status — FE polls this after redirect
const checkPaymentStatus = async (req, res) => {
  try {
    const { recordId } = req.params;

    const record = await prisma.billingRecord.findFirst({
      where: { id: recordId, userId: req.user.id },
      select: {
        id: true,
        billingMonth: true,
        isUnlocked: true,
        teaserAmount: true,
        payment: {
          select: {
            status: true,
            amountMyr: true,
            paidAt: true
          }
        }
      }
    });

    if (!record) {
      return res.status(404).json({ success: false, message: 'Record not found' });
    }

    res.json({
      success: true,
      isUnlocked: record.isUnlocked,
      billingMonth: record.billingMonth,
      paymentStatus: record.payment?.status || 'PENDING'
    });
  } catch (error) {
    console.error('Check payment status error:', error);
    res.status(500).json({ success: false, message: 'Failed to check status' });
  }
};

module.exports = { createPayment, webhook, checkPaymentStatus };