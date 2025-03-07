import { authenticate } from "@google-cloud/local-auth";
import { google } from "googleapis";
import fs from "fs";
import path from "path";

export const SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/spreadsheets",
];

// Get credentials directory from environment variable or use default
const CREDS_DIR =
  process.env.GDRIVE_CREDS_DIR ||
  path.join(path.dirname(new URL(import.meta.url).pathname), "../../../");

// Ensure the credentials directory exists
function ensureCredsDirectory() {
  try {
    fs.mkdirSync(CREDS_DIR, { recursive: true });
    console.error(`Ensured credentials directory exists at: ${CREDS_DIR}`);
  } catch (error) {
    console.error(
      `Failed to create credentials directory: ${CREDS_DIR}`,
      error,
    );
    throw error;
  }
}

const credentialsPath = path.join(CREDS_DIR, ".gdrive-server-credentials.json");

async function authenticateWithTimeout(
  keyfilePath: string,
  SCOPES: string[],
  timeoutMs = 30000,
): Promise<any | null> {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Authentication timed out")), timeoutMs),
  );

  const authPromise = authenticate({
    keyfilePath,
    scopes: SCOPES,
  });

  try {
    return await Promise.race([authPromise, timeoutPromise]);
  } catch (error) {
    console.error(error);
    return null;
  }
}

async function authenticateAndSaveCredentials() {
  console.error("Launching auth flow…");
  console.error("Using credentials path:", credentialsPath);

  const keyfilePath = path.resolve(process.cwd(), 'gcp-oauth.keys.json');
  console.error("Using keyfile path:", keyfilePath);

  const auth = await authenticateWithTimeout(keyfilePath, SCOPES);
  if (auth) {
    const newAuth = new google.auth.OAuth2();
    newAuth.setCredentials(auth.credentials);
  }

  try {
    const { credentials } = await auth.refreshAccessToken();
    console.error("Received new credentials with scopes:", credentials.scope);

    // Ensure directory exists before saving
    ensureCredsDirectory();

    fs.writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2));
    console.error(
      "Credentials saved successfully with refresh token to:",
      credentialsPath,
    );
    auth.setCredentials(credentials);
    return auth;
  } catch (error) {
    console.error("Error refreshing token during initial auth:", error);
    return auth;
  }
}

// Try to load credentials without prompting for auth
export async function loadCredentialsQuietly() {
  console.error("Attempting to load credentials from:", credentialsPath);

  const oauth2Client = new google.auth.OAuth2(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
  );

  if (!fs.existsSync(credentialsPath)) {
    console.error("No credentials file found");
    return null;
  }

  try {
    const savedCreds = JSON.parse(fs.readFileSync(credentialsPath, "utf-8"));
    console.error("Loaded existing credentials with scopes:", savedCreds.scope);
    oauth2Client.setCredentials(savedCreds);

    const expiryDate = new Date(savedCreds.expiry_date);
    const now = new Date();
    const fiveMinutes = 5 * 60 * 1000;
    const timeToExpiry = expiryDate.getTime() - now.getTime();

    console.error("Token expiry status:", {
      expiryDate: expiryDate.toISOString(),
      timeToExpiryMinutes: Math.floor(timeToExpiry / (60 * 1000)),
      hasRefreshToken: !!savedCreds.refresh_token,
    });

    if (timeToExpiry < fiveMinutes && savedCreds.refresh_token) {
      console.error("Attempting to refresh token using refresh_token");
      try {
        const response = await oauth2Client.refreshAccessToken();
        const newCreds = response.credentials;
        ensureCredsDirectory();
        fs.writeFileSync(credentialsPath, JSON.stringify(newCreds, null, 2));
        oauth2Client.setCredentials(newCreds);
        console.error("Token refreshed and saved successfully");
      } catch (error) {
        console.error("Failed to refresh token:", error);
        return null;
      }
    }

    return oauth2Client;
  } catch (error) {
    console.error("Error loading credentials:", error);
    return null;
  }
}

// Get valid credentials, prompting for auth if necessary
export async function getValidCredentials(forceAuth = false) {
  if (!forceAuth) {
    const quietAuth = await loadCredentialsQuietly();
    if (quietAuth) {
      return quietAuth;
    }
  }

  return await authenticateAndSaveCredentials();
}

// Background refresh that never prompts for auth
export function setupTokenRefresh() {
  console.error("Setting up automatic token refresh interval (45 minutes)");
  return setInterval(
    async () => {
      try {
        console.error("Running scheduled token refresh check");
        const auth = await loadCredentialsQuietly();
        if (auth) {
          google.options({ auth });
          console.error("Completed scheduled token refresh");
        } else {
          console.error("Skipping token refresh - no valid credentials");
        }
      } catch (error) {
        console.error("Error in automatic token refresh:", error);
      }
    },
    45 * 60 * 1000,
  );
}
