/**
 * proxy-token — Cloudflare Worker
 * ----------------------------------------------------------------------------
 * Nhận ảnh từ frontend (ViBaoBuilder), upload lên HuggingFace dataset
 * "Toilatop1sever/Data_2" bằng token Write giữ bí mật trong env (không lộ
 * cho browser). Trả về URL public của ảnh sau khi upload xong.
 *
 * Token KHÔNG được hard-code ở đây — set qua:
 *   wrangler secret put HF_TOKEN
 * ----------------------------------------------------------------------------
 */

export interface Env {
  HF_TOKEN: string; // HuggingFace token quyền Write, set qua `wrangler secret put HF_TOKEN`
  ALLOWED_ORIGIN: string; // domain frontend được phép gọi worker này (CORS)
}

const HF_DATASET = "Toilatop1sever/Data_2";
const HF_API_BASE = "https://huggingface.co/api/datasets";
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5MB — chặn upload quá nặng

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = env.ALLOWED_ORIGIN || "*";

    // Preflight CORS
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    if (request.method !== "POST") {
      return json({ error: "Chỉ hỗ trợ POST" }, 405, origin);
    }

    if (!env.HF_TOKEN) {
      return json({ error: "Server chưa cấu hình token" }, 500, origin);
    }

    let body: { filename?: string; dataUrl?: string };
    try {
      body = await request.json();
    } catch {
      return json({ error: "Body không hợp lệ, cần JSON" }, 400, origin);
    }

    const { filename, dataUrl } = body;
    if (!filename || !dataUrl || !dataUrl.startsWith("data:")) {
      return json({ error: "Thiếu filename hoặc dataUrl (định dạng data: URI)" }, 400, origin);
    }

    // Tách phần base64 ra khỏi "data:image/jpeg;base64,...."
    const match = dataUrl.match(/^data:(.+);base64,(.*)$/);
    if (!match) {
      return json({ error: "dataUrl không đúng định dạng base64" }, 400, origin);
    }
    const [, mime, base64] = match;
    const bytes = atob(base64);

    if (bytes.length > MAX_UPLOAD_BYTES) {
      return json({ error: "Ảnh quá lớn, tối đa 5MB" }, 413, origin);
    }

    // Đường dẫn file trong dataset: images/<timestamp>-<filename gốc, đã làm sạch>
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `images/${Date.now()}-${safeName}`;

    try {
      const uploadUrl = await uploadToHuggingFace({
        token: env.HF_TOKEN,
        path,
        bytes,
        mime,
      });
      return json({ url: uploadUrl }, 200, origin);
    } catch (err) {
      return json(
        { error: err instanceof Error ? err.message : "Upload thất bại" },
        502,
        origin,
      );
    }
  },
};

/**
 * Upload 1 file lên HuggingFace dataset qua Hub API (commit trực tiếp,
 * không cần git clone toàn bộ repo).
 * Docs: https://huggingface.co/docs/huggingface_hub/package_reference/hf_api#huggingface_hub.HfApi.upload_file
 */
async function uploadToHuggingFace(opts: {
  token: string;
  path: string;
  bytes: string; // raw binary string (đã atob)
  mime: string;
}): Promise<string> {
  const { token, path, bytes, mime } = opts;

  // Convert raw binary string -> Uint8Array để gửi đúng dạng nhị phân
  const len = bytes.length;
  const buffer = new Uint8Array(len);
  for (let i = 0; i < len; i++) buffer[i] = bytes.charCodeAt(i);

  // HuggingFace Hub hỗ trợ upload qua endpoint commit-based hoặc qua
  // resolve/upload trực tiếp với token Bearer. Dùng endpoint upload đơn file:
  const uploadEndpoint = `https://huggingface.co/api/datasets/${HF_DATASET}/upload/main/${path}`;

  const res = await fetch(uploadEndpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": mime || "application/octet-stream",
    },
    body: buffer,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HuggingFace upload lỗi (${res.status}): ${text.slice(0, 200)}`);
  }

  // URL public để xem/tải file sau khi commit thành công
  return `https://huggingface.co/datasets/${HF_DATASET}/resolve/main/${path}`;
}

function json(data: unknown, status: number, origin: string): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin),
    },
  });
}
