import { getFunctions, httpsCallable } from "firebase/functions";
import { getApp } from "firebase/app";

// All Gemini calls are proxied through Cloud Functions.
// The API key lives in Secret Manager and never reaches the browser bundle.

const getFns = () => getFunctions(getApp());

export function createSmartReplyRequestKey(conversationId: string, messageId: string): string {
  return `${conversationId}:${messageId}`;
}

export interface SignAnalysisResult {
  status: "YES" | "NO" | "CONDITIONAL" | "ERROR";
  explanation: string;
  restrictionStartsAt?: string | null;
  restrictionEndsAt?: string | null;
  actionableAdvice?: string | null;
}

/** ERROR explanation when the callable itself failed (quota, rate limit, outage) — not the photo's fault. */
export const SIGN_ANALYSIS_UNAVAILABLE_EXPLANATION =
  "Assistant temporarily unavailable\nThe AI service is temporarily unavailable. Please try again shortly.";
/** ERROR explanation for any other failure; a retake is the most useful next step. */
export const SIGN_ANALYSIS_UNREADABLE_EXPLANATION =
  "Couldn't read this sign\nTry taking another photo with the full sign visible and in focus.";

/**
 * True when an ERROR result came from the service being unavailable rather than from the photo.
 * Lets the scanner lead with "Try again" (same photo) instead of "Retake" without adding a field
 * to the analyzeSign response contract.
 */
export const isSignAnalysisUnavailable = (result: SignAnalysisResult): boolean =>
  result.status === "ERROR" && result.explanation === SIGN_ANALYSIS_UNAVAILABLE_EXPLANATION;

export const analyzeParkingSign = async (imageBase64: string): Promise<SignAnalysisResult> => {
  try {
    const fn = httpsCallable<{ imageBase64: string }, SignAnalysisResult>(getFns(), "analyzeSign");
    const result = await fn({ imageBase64 });
    return result.data;
  } catch (error: any) {
    console.error("Gemini Vision Error:", error);
    const code = error?.code ?? error?.details?.code ?? "";
    if (code === "resource-exhausted" || code === "failed-precondition" || code === "unavailable" || code === "internal") {
      return { status: "ERROR", explanation: SIGN_ANALYSIS_UNAVAILABLE_EXPLANATION };
    }
    return { status: "ERROR", explanation: SIGN_ANALYSIS_UNREADABLE_EXPLANATION };
  }
};

export const generateListingDescription = async (features: string[]): Promise<string> => {
  try {
    const fn = httpsCallable<{ features: string[] }, { description: string }>(
      getFns(),
      "generateListingDescription"
    );
    const result = await fn({ features });
    return result.data.description;
  } catch (error) {
    console.error("Gemini Text Error:", error);
    return "Secure parking spot available for rent.";
  }
};

export const generateSmartReplies = async (
  lastMessage: string,
  context: string
): Promise<string[]> => {
  try {
    const fn = httpsCallable<
      { lastMessage: string; context: string },
      { replies: string[] }
    >(getFns(), "generateSmartReplies");
    const result = await fn({ lastMessage, context });
    return result.data.replies;
  } catch (error) {
    console.error("Gemini Chat Error:", error);
    return ["I'm interested!", "Is it available?", "Thanks!"];
  }
};
