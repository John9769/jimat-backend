const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const { getChainStatus, getPricing } = require('../engine/chainEngine');

const prisma = new PrismaClient();

const createPayment = async (req, res) => {
  try {
    const { recordId } = req.body;

    if (!recordId) {
      return res.status(400).json({ success: false, message: 'recordId required' });
    }

    const record = await prisma.billingRecord.findFirst({
      where: { id: recordId, userId: req.user.id }
    });

    if (!record) {
      return res.status(404).json({ success: false, message: 'Billing record not found' });
    }

    if (record.isUnlocked) {
      return res.status(400).json({ success: false, message: 'Report already unlocked' });
    }

    const existingPayment = await prisma.payment.findFirst({
      where: {
        userId: req.user.id,
        status: 'PENDING',
        billingRecords: { some: { id: recordId } }
      }
    });

    if (existingPayment) {
      return res.json({
        success: true,
        billCode: existingPayment.toyyibpayBillCode,
        paymentUrl: `${process.env.TOYYIBPAY_BASE_URL}/${existingPayment.toyyibpayBillCode}`,
        amount: existingPayment.amountMyr
      });
    }

    const chainStatus = await getChainStatus(req.user.id, prisma);

    // Check if user has any previous successful payments
    // If none — this is their first payment — charge ONBOARD price
    const previousPayments = await prisma.payment.count({
      where: { userId: req.user.id, status: 'SUCCESS' }
    });
    const effectiveChainStatus = previousPayments === 0 ? 'ONBOARD' : chainStatus.status;
    const pricing = getPricing(req.user.userType, effectiveChainStatus);

    const categoryCode = req.user.userType === 'INSTITUTIONAL'
      ? process.env.TOYYIBPAY_CATEGORY_INSTITUTIONAL
      : process.env.TOYYIBPAY_CATEGORY_HOUSEHOLD;

    const billRef = `JIMAT-${req.user.id.slice(-6).toUpperCase()}-${Date.now()}`;
    const amountCents = Math.round(pricing.total * 100);

    const fullUser = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { name: true, email: true, phone: true }
    });

    // ToyyibPay payload — exact fields required
    // billEmail MUST be included
    // billChargeToCustomer:1 = customer pays gateway fee
    // NEVER include billEmail in URLSearchParams as empty
    const toyyibPayload = new URLSearchParams();
    toyyibPayload.append('userSecretKey', process.env.TOYYIBPAY_API_KEY);
    toyyibPayload.append('categoryCode', categoryCode);
    toyyibPayload.append('billName', `JIMAT ${chainStatus.status === 'MONTHLY' ? 'Monthly' : 'Onboard'} Analysis`);
    toyyibPayload.append('billDescription', `JIMAT electricity bill analysis - ${record.billingMonth}`);
    toyyibPayload.append('billPriceSetting', '1');
    toyyibPayload.append('billPayorInfo', '1');
    toyyibPayload.append('billAmount', amountCents.toString());
    toyyibPayload.append('billReturnUrl', `${process.env.FRONTEND_URL}/payment/success`);
    toyyibPayload.append('billCallbackUrl', `${process.env.BACKEND_URL}/api/payment/webhook`);
    toyyibPayload.append('billExternalReferenceNo', billRef);
    toyyibPayload.append('billTo', fullUser.name);
    toyyibPayload.append('billEmail', fullUser.email);
    toyyibPayload.append('billPhone', fullUser.phone || '0123456789');
    toyyibPayload.append('billSplitPayment', '0');
    toyyibPayload.append('billSplitPaymentArgs', '');
    toyyibPayload.append('billPaymentChannel', '0');
    toyyibPayload.append('billDisplayMerchant', '1');
    toyyibPayload.append('billContentEmail', `Terima kasih kerana menggunakan JIMAT. Laporan analisis bil elektrik anda untuk ${record.billingMonth} sudah bersedia.`);
    toyyibPayload.append('billChargeToCustomer', '1');
    toyyibPayload.append('enableDuitNowQR', '1');
    toyyibPayload.append('chargeDuitNowQR', '0');

    console.log('Creating ToyyibPay bill:', {
      billRef,
      amount: amountCents,
      email: fullUser.email,
      callbackUrl: `${process.env.BACKEND_URL}/api/payment/webhook`
    });

    const toyyibResponse = await axios.post(
      `${process.env.TOYYIBPAY_BASE_URL}/index.php/api/createBill`,
      toyyibPayload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const billData = toyyibResponse.data;
    console.log('ToyyibPay response:', billData);

    if (!billData || !billData[0] || !billData[0].BillCode) {
      console.error('ToyyibPay error response:', billData);
      return res.status(500).json({ success: false, message: 'Failed to create payment bill' });
    }

    const billCode = billData[0].BillCode;

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

    console.log('Payment created:', { billCode, paymentId: payment.id });

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

// ToyyibPay webhook
// CRITICAL NOTES:
// 1. ToyyibPay sends POST with application/x-www-form-urlencoded
// 2. Field name is 'billcode' (lowercase) NOT 'BillCode'
// 3. status '1' = success, '2' = pending, '3' = failed
// 4. ALWAYS return HTTP 200 — never 4xx/5xx or ToyyibPay will retry endlessly
// 5. req.body is parsed by express.urlencoded registered BEFORE this route in server.js
const webhook = async (req, res) => {
  try {
    // Log everything for debugging
    console.log('=== TOYYIBPAY WEBHOOK RECEIVED ===');
    console.log('Content-Type:', req.headers['content-type']);
    console.log('Raw body:', req.body);

    // Handle all possible field name variants from ToyyibPay
    const billcode = req.body?.billcode
      || req.body?.BillCode
      || req.body?.bill_code
      || req.body?.billCode
      || null;

    const order_id = req.body?.order_id
      || req.body?.orderId
      || req.body?.OrderId
      || req.body?.refNo
      || null;

    const status = req.body?.status
      || req.body?.Status
      || null;

    const reason = req.body?.reason
      || req.body?.Reason
      || null;

    console.log('Parsed webhook fields:', { billcode, order_id, status, reason });

    // Always return 200 first to acknowledge receipt
    // Then process — this prevents ToyyibPay timeout issues
    if (!billcode) {
      console.error('WEBHOOK ERROR: billcode missing. Body was:', JSON.stringify(req.body));
      return res.status(200).send('OK');
    }

    const payment = await prisma.payment.findFirst({
      where: { toyyibpayBillCode: billcode },
      include: { billingRecords: true }
    });

    if (!payment) {
      console.error('WEBHOOK ERROR: Payment not found for billcode:', billcode);
      return res.status(200).send('OK');
    }

    // Prevent double processing
    if (payment.status === 'SUCCESS') {
      console.log('Webhook: Payment already processed:', billcode);
      return res.status(200).send('OK');
    }

    // Process payment status
    // ToyyibPay sends status as string '1' for success
    const isSuccess = status === '1' || status === 1 || String(status) === '1';

    if (isSuccess) {
      // Atomic transaction — update payment + unlock all billing records
      await prisma.$transaction(async (tx) => {
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: 'SUCCESS',
            toyyibpayOrderId: order_id ? String(order_id) : null,
            paidAt: new Date()
          }
        });

        for (const record of payment.billingRecords) {
          await tx.billingRecord.update({
            where: { id: record.id },
            data: { isUnlocked: true }
          });
          console.log('Report unlocked for billingRecord:', record.id, record.billingMonth);
        }
      });

      console.log('=== PAYMENT SUCCESS — REPORT UNLOCKED ===', billcode);

    } else {
      // Failed or pending
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'FAILED' }
      });
      console.log('Payment FAILED/PENDING for billcode:', billcode, 'status:', status, 'reason:', reason);
    }

    return res.status(200).send('OK');

  } catch (error) {
    // Log error but ALWAYS return 200 to ToyyibPay
    console.error('=== WEBHOOK PROCESSING ERROR ===', error);
    return res.status(200).send('OK');
  }
};

const checkPaymentStatus = async (req, res) => {
  try {
    const { recordId } = req.params;

    const record = await prisma.billingRecord.findFirst({
      where: { id: recordId, userId: req.user.id },
      select: {
        id: true,
        billingMonth: true,
        isUnlocked: true,
        teaserLow: true,
        teaserHigh: true,
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