const { default: makeWASocket, useMultiFileAuthState,
DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

// 🌟 SECURE FIREBASE URL FROM GITHUB SECRETS 🌟
const FIREBASE_URL = process.env.FIREBASE_URL;

const orderStates = {};

// Function to fetch the dynamic menu from your App's Firebase
async function getMenuFromApp() {
  try {
    const response = await fetch(`${FIREBASE_URL}/dishes.json`);
    const data = await response.json();
    if (!data) return [];

    // Convert Firebase object into an array (now includes imageUrl)
    return Object.keys(data).map(key => ({
      id: key,
      name: data[key].name,
      price: data[key].price,
      imageUrl: data[key].imageUrl
    }));
  } catch (error) {
    console.error("Failed to fetch menu:", error);
    return [];
  }
}

async function startBot() {
  if (!FIREBASE_URL) {
    console.log("❌ ERROR: FIREBASE_URL is missing in GitHub Secrets!");
    process.exit(1);
  }

  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  });

  // Save credentials on update
  sock.ev.on('creds.update', saveCreds);

  // QR Code generation
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrcode.generate(qr, { small: true });
      console.log('📱 Scan the QR code above to connect WhatsApp!');
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) {
        startBot();
      }
    } else if (connection === 'open') {
      console.log('✅ WhatsApp Bot connected successfully!');
    }
  });

  // Message handler
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      '';

    const lowerText = text.trim().toLowerCase();

    // Initialize order state for new users
    if (!orderStates[sender]) {
      orderStates[sender] = { step: 'idle', cart: [], name: '' };
    }

    const userState = orderStates[sender];

    // --- MENU command ---
    if (lowerText === 'menu' || lowerText === 'hi' || lowerText === 'hello') {
      const menuItems = await getMenuFromApp();

      if (menuItems.length === 0) {
        await sock.sendMessage(sender, { text: '⚠️ Menu is currently unavailable. Please try again later.' });
        return;
      }

      let menuText = '🍽️ *Welcome to JavaGoat!* 🍽️\n\nHere is our menu:\n\n';
      menuItems.forEach((item, index) => {
        menuText += `*${index + 1}.* ${item.name} - Rs. ${item.price}\n`;
      });
      menuText += '\nReply with the *item number* to add to your cart.\nType *cart* to view your order.\nType *confirm* to place your order.';

      await sock.sendMessage(sender, { text: menuText });
      userState.step = 'ordering';
      userState.menuItems = menuItems;

    // --- Add item to cart ---
    } else if (userState.step === 'ordering' && !isNaN(lowerText)) {
      const index = parseInt(lowerText) - 1;
      const menuItems = userState.menuItems || await getMenuFromApp();

      if (index >= 0 && index < menuItems.length) {
        const selectedItem = menuItems[index];
        userState.cart.push(selectedItem);
        await sock.sendMessage(sender, {
          text: `✅ *${selectedItem.name}* added to your cart!\n\nType another number to add more, *cart* to review, or *confirm* to place order.`
        });
      } else {
        await sock.sendMessage(sender, { text: '❌ Invalid item number. Please try again.' });
      }

    // --- View cart ---
    } else if (lowerText === 'cart') {
      if (userState.cart.length === 0) {
        await sock.sendMessage(sender, { text: '🛒 Your cart is empty. Type *menu* to browse items.' });
      } else {
        let cartText = '🛒 *Your Cart:*\n\n';
        let total = 0;
        userState.cart.forEach((item, index) => {
          cartText += `${index + 1}. ${item.name} - Rs. ${item.price}\n`;
          total += item.price;
        });
        cartText += `\n*Total: Rs. ${total}*\n\nType *confirm* to place your order or *clear* to empty cart.`;
        await sock.sendMessage(sender, { text: cartText });
      }

    // --- Clear cart ---
    } else if (lowerText === 'clear') {
      userState.cart = [];
      userState.step = 'idle';
      await sock.sendMessage(sender, { text: '🗑️ Cart cleared! Type *menu* to start again.' });

    // --- Confirm order ---
    } else if (lowerText === 'confirm') {
      if (userState.cart.length === 0) {
        await sock.sendMessage(sender, { text: '⚠️ Your cart is empty. Type *menu* to add items.' });
      } else {
        let total = userState.cart.reduce((sum, item) => sum + item.price, 0);
        await sock.sendMessage(sender, {
          text: `🎉 *Order Confirmed!*\n\nThank you! Your order has been placed.\n💰 Total: Rs. ${total}\n\n⏳ Estimated delivery: 30-45 minutes.\n\nType *menu* to order again!`
        });
        // Reset state after order
        orderStates[sender] = { step: 'idle', cart: [], name: '' };
      }

    // --- Default fallback ---
    } else {
      await sock.sendMessage(sender, {
        text: '👋 Hi! Type *menu* to see our menu, *cart* to view your order, or *confirm* to place it.'
      });
    }
  });
}

// Start the bot
startBot();
