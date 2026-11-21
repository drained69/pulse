# Device receiver

Unlock a lock, start a machine or vend something when a Q-Pulse product is paid on QIE.

1. In the dashboard: **Payment links → Products → New product** (price, and optional unlock content for the buyer).
2. **Hooks → New hook → Payment link paid**, channel **Webhook**, URL = where this receiver is reachable over HTTPS
   (a tunnel such as Cloudflare Tunnel works for a Raspberry Pi at home). Copy the hook's signing secret.
3. On the device (Node 18+, no npm install):

   ```bash
   QPULSE_SECRET=whsec_… PRODUCT_ID=prd_… UNLOCK_CMD="gpioset gpiochip0 17=1; sleep 30; gpioset gpiochip0 17=0" node receiver.mjs
   ```

4. Print the product's QR code (the **QR** button) and stick it on the machine.

The receiver checks the HMAC signature and timestamp, ignores other products, and acts once per payment even if the
event is delivered twice. Without `UNLOCK_CMD` it only logs `UNLOCK …`: try that first with a real 0.01 QIE purchase.
(The hook's **Send test** button sends a `test` event, which the receiver ignores on purpose.)

No hardware for a demo? Open the product's **Device view**: a screen with the QR code and a lock that opens live.
