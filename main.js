const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const fs = require('fs');

// Load environment variables from .env file
if (fs.existsSync('.env')) {
    const envContent = fs.readFileSync('.env', 'utf8');
    envContent.split('\n').forEach(line => {
        const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
        if (match) {
            const key = match[1];
            let value = match[2] || '';
            // Remove quotes if present
            if (value.length > 0 && value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') {
                value = value.substring(1, value.length - 1);
            } else if (value.length > 0 && value.charAt(0) === "'" && value.charAt(value.length - 1) === "'") {
                value = value.substring(1, value.length - 1);
            }
            process.env[key] = value;
        }
    });
}

// Function to create a fresh authenticated client per account session
function createClient() {
    const jar = new CookieJar();
    return wrapper(axios.create({
        jar,
        withCredentials: true,
        maxRedirects: 0, // We must handle the jump manually to keep the session alive
        validateStatus: (status) => status >= 200 && status < 400,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
        }
    }));
}

async function runAttendance(username, password, attendanceUrl) {
    const client = createClient();
    try {
        console.log(`--- ATTENDANCE CHECK: ${username} ---`);

        // 1. Get the OAuth start point
        const res1 = await client.get(attendanceUrl);
        if (res1.data.includes("Logout") || res1.data.includes("ออกจากระบบ")) {
            console.log("ℹ️ Already logged in. Checking result...");
            return processResult(res1.data);
        }

        const oauthLink = res1.data.match(/id="courseville-login-w-platform-cu-button"[^>]*href="([^"]+)"/);
        if (!oauthLink) {
            console.error("❌ Could not find login button. Checking status...");
            return processResult(res1.data);
        }
        const loginUrl = oauthLink[1].replace(/&amp;/g, '&');

        // 2. Load Login Page
        let res2 = await client.get(loginUrl);
        while (res2.status === 302) {
            res2 = await client.get(res2.headers.location);
        }

        const tokenMatch = res2.data.match(/name="_token" value="([^"]+)"/);
        if (!tokenMatch) throw new Error("Could not find CSRF token.");
        const token = tokenMatch[1];

        // 3. POST Login
        console.log("Authenticating...");
        const params = new URLSearchParams();
        params.append('_token', token);
        params.append('username', username);
        params.append('password', password);

        // myCourseVille CU login endpoint
        const res3 = await client.post('https://www.mycourseville.com/api/chulalogin', params, {
            headers: {
                'Referer': 'https://www.mycourseville.com/api/login',
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        // 4. THE BRIDGE: Manually follow the redirect to the ?code= URL
        if (res3.status === 302) {
            const recordingUrl = res3.headers.location;

            // If it redirects back to the login page, authentication actually failed
            if (recordingUrl.includes('/api/login')) {
                console.error("❌ Authentication failed: Invalid username or password.");
                return;
            }

            console.log("✅ Authentication success. Following session bridge...");

            const customHeaders = {
                'Referer': 'https://www.mycourseville.com/api/login',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'same-origin'
            };

            const res4 = await client.get(recordingUrl, { headers: customHeaders });

            if (res4.status === 302) {
                const finalRes = await client.get(res4.headers.location, { headers: customHeaders });
                processResult(finalRes.data);
            } else {
                processResult(res4.data);
            }
        } else {
            console.log("⚠️ Auth didn't return a redirect. Current Page Content Size:", res3.data.length);
            processResult(res3.data);
        }

    } catch (error) {
        console.error("❌ Error:", error.message);
    }
}

function processResult(html) {
    // 1. Check for Not Logged In state
    if (html.includes('id="courseville-login-button-list"')) {
        console.log("❌ LOGIN REQUIRED: The system is currently logged out.");
        return;
    }

    // 2. Check for "Recorded" state
    if (/Your attendance for.*has been recorded/s.test(html) || html.includes("บันทึกการเข้าเรียนเรียบร้อยแล้ว")) {
        const dateMatch = html.match(/<strong>(.*?)<\/strong>/);
        const dateStr = dateMatch ? dateMatch[1] : "Unknown Date";
        console.log(`🎉 SUCCESS: Attendance for ${dateStr} has been recorded.`);
        return;
    }

    // 3. Check for "Invalid or Expired" state
    if (html.includes("Invalid or Expired attendance check code")) {
        console.log("⚠️ EXPIRED: The attendance code is invalid or has expired.");
        return;
    }

    // 4. Generic status extraction
    const genericMsg = html.match(/<div class="cvui(?:-margin-v)? cvui-center">([\s\S]*?)<\/div>/);
    if (genericMsg) {
        const cleaned = genericMsg[1].replace(/<[^>]*>?/gm, '').trim().replace(/\s+/g, ' ');
        console.log("ℹ️ STATUS:", cleaned);
    } else {
        console.log("❓ UNKNOWN: Result page content didn't match expected patterns.");
    }
}

const ATTENDANCE_URL = process.env.ATTENDANCE_URL;
const ACCOUNTS = JSON.parse(process.env.ACCOUNTS || '[]');

(async () => {
    if (!ATTENDANCE_URL) {
        console.error("❌ Error: ATTENDANCE_URL is not defined in .env");
        return;
    }
    if (ACCOUNTS.length === 0) {
        console.error("❌ Error: No ACCOUNTS defined in .env");
        return;
    }

    for (const account of ACCOUNTS) {
        await runAttendance(account.user, account.pass, ATTENDANCE_URL);
        console.log(""); // Blank line for readability
    }
})();