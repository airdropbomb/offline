const axios = require('axios');
const fs = require('fs').promises;

// API endpoints and base URLs
const checkUrl = "https://protocolbackend-production.up.railway.app/api/v1/id/verify";
const registerUrl = "https://protocolbackend-production.up.railway.app/api/v1/id/order";
const discountBaseUrl = "https://api.copperx.io/api/v1/payment-pages/for-checkout-session/";
const paymentBaseUrl = "https://api.copperx.io/api/v1/payment-pages/for-checkout-session/";
const homeBaseUrl = "https://id.offlineprotocol.com/";

// File paths
const accountsFile = "accounts.txt";
const unavailableFile = "unavailable_usernames.txt";
const registeredFile = "registered_usernames.txt";
const logFile = "log.txt";

// Function to log messages to both console and file
async function logMessage(message) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}\n`;
    console.log(message);
    await fs.appendFile(logFile, logEntry);
}

// Function to read accounts from accounts.txt
async function getAccounts() {
    try {
        const data = await fs.readFile(accountsFile, 'utf8');
        const lines = data.split('\n').filter(line => line.trim());
        const accounts = lines.map(line => {
            const [email, token] = line.split(',').map(item => item.trim());
            if (!email || !token) {
                throw new Error(`Invalid format in accounts.txt: ${line}`);
            }
            return { email, authToken: `Bearer ${token}` };
        });
        return accounts;
    } catch (error) {
        await logMessage(`Error reading accounts from accounts.txt: ${error.message}`);
        process.exit(1);
    }
}

// Function to generate usernames (letters only, 5 characters)
function generateUsernames() {
    const chars = 'abcdefghijklmnopqrstuvwxyz';
    const usernames = [];
    const length = 5; // Fixed to 5 characters
    for (let i = 0; i < 1000; i++) { // Generate 1000 random usernames
        let username = '';
        for (let j = 0; j < length; j++) {
            username += chars[Math.floor(Math.random() * chars.length)];
        }
        usernames.push(username);
    }
    return [...new Set(usernames)]; // Remove duplicates
}

// Function to delay execution
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Function to send HTTP requests without proxy and user-agent
async function sendRequest(url, data = null, authToken, isGet = false) {
    try {
        const config = {
            method: isGet ? 'get' : 'post',
            url,
            headers: {
                "Content-Type": "application/json",
                "Authorization": authToken
            },
            data: data ? data : undefined
        };
        const response = await axios(config);
        return {
            status: 1,
            httpCode: response.status,
            response: response.data,
            rawResponse: response.data
        };
    } catch (error) {
        const errorDetails = error.response ? 
            `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}` : 
            `Network Error: ${error.message}`;
        return {
            status: 0,
            httpCode: error.response?.status || 500,
            response: error.response?.data || {},
            rawResponse: errorDetails
        };
    }
}

// Main logic
(async () => {
    // Get all accounts
    const accounts = await getAccounts();

    if (accounts.length === 0) {
        await logMessage("No accounts found in accounts.txt");
        process.exit(1);
    }

    // Load unavailable usernames
    let unavailableUsernames = [];
    try {
        const data = await fs.readFile(unavailableFile, 'utf8');
        unavailableUsernames = data.split('\n').filter(line => line.trim());
    } catch (error) {
        if (error.code !== 'ENOENT') await logMessage(`Error loading unavailable usernames: ${error}`);
    }

    const allUsernames = generateUsernames();

    // Process each account
    for (let i = 0; i < accounts.length; i++) {
        const account = accounts[i];
        await logMessage(`Starting registration process with email: ${account.email}`);

        for (const username of allUsernames) {
            if (unavailableUsernames.includes(username)) {
                await logMessage(`${username} was previously unavailable, skipping...`);
                continue;
            }

            await logMessage(`Processing ${username} with ${account.email}...`);

            // Step 1: Check username availability
            const checkData = { username };
            const checkResponse = await sendRequest(checkUrl, checkData, account.authToken);
            // Workaround: Treat HTTP 500 with "status":0 as "not available"
            if (checkResponse.status !== 1 || (checkResponse.httpCode === 500 && checkResponse.response.status === 0)) {
                await logMessage(`${username} is not available, skipping... (${checkResponse.rawResponse})`);
                await fs.appendFile(unavailableFile, `${username}\n`);
                await delay(1000); // 1 second delay
                continue;
            }

            // Step 2: Register account for 3 years
            const registerData = {
                email: account.email,
                username,
                years: 3,
                currency: "usdc",
                islite: false
            };
            const registerResponse = await sendRequest(registerUrl, registerData, account.authToken);
            if (registerResponse.httpCode !== 200 || registerResponse.response.status !== 1) {
                await logMessage(`Registration failed for ${username}: ${registerResponse.rawResponse}`);
                await fs.appendFile(unavailableFile, `${username}\n`);
                await delay(1000); // 1 second delay
                continue;
            }

            // Get checkout URL
            const checkoutUrl = registerResponse.response.data?.url;
            if (!checkoutUrl) {
                await logMessage(`Checkout URL not found for ${username}, skipping...`);
                await delay(1000); // 1 second delay
                continue;
            }

            // Extract session ID
            const urlParts = checkoutUrl.split('/');
            const sessionId = urlParts[urlParts.length - 1];
            if (!sessionId) {
                await logMessage(`Session ID not found for ${username}, skipping...`);
                await delay(1000); // 1 second delay
                continue;
            }

            // Step 3: Apply PRESEED discount code
            const discountUrl = `${discountBaseUrl}${sessionId}/discount`;
            const discountData = { code: "PRESEED" };
            const discountResponse = await sendRequest(discountUrl, discountData, account.authToken);
            if (discountResponse.httpCode !== 200) {
                await logMessage(`Discount apply failed for ${username}: ${discountResponse.rawResponse}`);
                await delay(1000); // 1 second delay
                continue;
            }

            // Check if amount total is 0
            const amountTotal = discountResponse.response.amountTotal;
            if (amountTotal !== "0" && amountTotal !== 0) {
                await logMessage(`Discount apply failed for ${username}: Amount due is ${amountTotal}`);
                await delay(1000); // 1 second delay
                continue;
            }

            // Step 4: Complete payment (0.00 due to discount)
            const paymentUrl = `${paymentBaseUrl}${sessionId}/mark-session-complete-for-zero-amount`;
            const paymentResponse = await sendRequest(paymentUrl, {}, account.authToken);
            if (paymentResponse.httpCode !== 200) {
                await logMessage(`Payment failed for ${username}: ${paymentResponse.rawResponse}`);
                await delay(1000); // 1 second delay
                continue;
            }

            // Get success URL
            let successUrl = paymentResponse.response.successUrl;
            if (!successUrl) {
                await logMessage(`Success URL not found for ${username}, constructing manually...`);
                successUrl = `${homeBaseUrl}${username}/claimed?cx_session_id=${sessionId}`;
            }

            // Step 5: Return to Home and validate
            const homeResponse = await sendRequest(successUrl, null, account.authToken, true);
            if (homeResponse.httpCode !== 200) {
                await logMessage(`Failed to return to Home for ${username}: ${homeResponse.rawResponse}`);
                await delay(1000); // 1 second delay
                continue;
            }

            // Check for success message
            const responseBody = homeResponse.rawResponse;
            if (!responseBody.includes("Congratulations, you’ve gone offline!!!")) {
                await logMessage(`Success message not found for ${username}, registration might have failed.`);
                await delay(1000); // 1 second delay
                continue;
            }

            // Validate displayed username
            const usernameMatch = responseBody.match(/<p class="text-3xl font-instrumentSerif italic text-primary py-5">([a-zA-Z]+)<span/);
            if (usernameMatch) {
                const displayedUsername = usernameMatch[1];
                if (displayedUsername !== username) {
                    await logMessage(`Username mismatch for ${username}: Expected ${username}, got ${displayedUsername}`);
                    await delay(1000); // 1 second delay
                    continue;
                }
            }

            // Log success and save to file
            await logMessage(`${username} successfully registered with ${account.email} and returned to Home.`);
            await fs.appendFile(registeredFile, `${username},${account.email}\n`);
            await delay(1000); // 1 second delay after success
            await logMessage("Moving to next username...");
        }

        await logMessage(`Finished processing all usernames for ${account.email}. Moving to next account...`);
    }

    await logMessage("All accounts processed successfully!");
})();