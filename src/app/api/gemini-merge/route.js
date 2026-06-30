import { NextResponse } from 'next/server';
import sharp from 'sharp';
import { GoogleGenAI } from '@google/genai';

// --- Configuration ---
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://kacaps.myshopify.com',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const MAX_PAYLOAD_SIZE = 10 * 1024 * 1024; // 10MB limit

// --- Helper Functions ---
const normalizeImageUrl = (url) => url?.startsWith('//') ? `https:${url}` : url;
const stripBase64 = (data) => data.replace(/^data:image\/\w+;base64,/, '');
const bufferToDataUrl = (buffer, mimeType = 'image/png') => `data:${mimeType};base64,${buffer.toString('base64')}`;

// --- Core Image Processing ---
async function compositeImages(capImageUrl, canvasBase64) {
  // 1. Fetch product image from URL
  const response = await fetch(capImageUrl);
  if (!response.ok) throw new Error(`Failed to download product image: ${response.statusText}`);
  
  const capBuffer = await response.arrayBuffer();
  
  // 2. Parse canvas guide from Base64
  const stickerBuffer = Buffer.from(stripBase64(canvasBase64), 'base64');

  const capSharp = sharp(Buffer.from(capBuffer));
  const capMetadata = await capSharp.metadata();

  // 3. Resize canvas guide to exactly match the product image dimensions
  const resizedStickerBuffer = await sharp(stickerBuffer)
    .resize(capMetadata.width, capMetadata.height, { fit: 'fill' })
    .toBuffer();

  // 4. Composite together for pixel-perfect placement
  return await capSharp
    .composite([{ input: resizedStickerBuffer }])
    .png()
    .toBuffer();
}

async function enhanceWithGemini(compositedBuffer, promptText) {
  if (!process.env.GEMINI_API_KEY) {
    console.warn('GEMINI_API_KEY missing. Returning standard composite.');
    return compositedBuffer;
  }

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    
    // Fallback prompt if none provided
    const finalPrompt = promptText || "Seamlessly blend the applied stickers into the product image, matching lighting, shadows, and texture perfectly while keeping exact placement.";

    // Note: Use the appropriate image generation model available to your API tier
    const response = await ai.models.generateImages({
        model: 'imagen-3.0-generate-001',
        prompt: finalPrompt,
        image: {
            imageBytes: compositedBuffer.toString('base64'),
        },
        numberOfImages: 1,
        outputMimeType: 'image/png',
    });

    const outputBase64 = response.generatedImages?.[0]?.image?.imageBytes;

    if (!outputBase64) throw new Error("AI returned no image data.");
    
    return Buffer.from(outputBase64, 'base64');
  } catch (error) {
    console.error('AI enhancement failed, falling back to basic composite:', error.message);
    return compositedBuffer; // Always fallback to the safe composite if AI fails
  }
}

// --- API Route Handlers ---
export async function OPTIONS() {
  return new NextResponse(null, { headers: CORS_HEADERS, status: 200 });
}

export async function POST(req) {
  try {
    // 1. Validate payload size
    const contentLength = req.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_PAYLOAD_SIZE) {
      return NextResponse.json({ success: false, error: 'Payload too large' }, { status: 413, headers: CORS_HEADERS });
    }

    // 2. Parse request body
    const { canvas_image, product_image, prompt } = await req.json();

    if (!canvas_image || !product_image) {
      return NextResponse.json(
        { success: false, error: 'Missing canvas_image or product_image' }, 
        { status: 400, headers: CORS_HEADERS }
      );
    }

    // 3. Process Images
    const compositedBuffer = await compositeImages(normalizeImageUrl(product_image), canvas_image);
    const finalBuffer = await enhanceWithGemini(compositedBuffer, prompt);

    // 4. Return Data URL to frontend
    return NextResponse.json(
      { success: true, image: bufferToDataUrl(finalBuffer) },
      { status: 200, headers: CORS_HEADERS }
    );

  } catch (error) {
    console.error('Merge Error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Failed to process images' }, 
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
