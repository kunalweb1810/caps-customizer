const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://kacaps.myshopify.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shopifyGraphQL(shop, token, version, query, variables = {}) {
  const res = await fetch(`https://${shop}/admin/api/${version}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({
      query,
      variables,
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(
      data?.errors?.[0]?.message || "Shopify GraphQL request failed",
    );
  }

  return data;
}

export async function POST(request) {
  try {
    const { file, filename } = await request.json();

    const shop = process.env.SHOPIFY_STORE;
    const token = process.env.SHOPIFY_ADMIN_TOKEN;
    const version = process.env.SHOPIFY_API_VERSION || "2025-10";

    if (!shop) throw new Error("SHOPIFY_STORE is missing");
    if (!token) throw new Error("SHOPIFY_ADMIN_TOKEN is missing");

    // Detect MIME type
    let mimeType = "image/png";
    let contentType = "IMAGE";

    const mimeMatch =
      typeof file === "string" ? file.match(/^data:([^;]+);base64,/) : null;

    if (mimeMatch?.[1]) {
      mimeType = mimeMatch[1];

      if (!mimeType.startsWith("image/")) {
        contentType = "FILE";
      }
    }

    // 1. Create staged upload target
    const stagedData = await shopifyGraphQL(
      shop,
      token,
      version,
      `
          mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
            stagedUploadsCreate(input: $input) {
              stagedTargets {
                url
                resourceUrl
                parameters {
                  name
                  value
                }
              }
              userErrors {
                field
                message
              }
            }
          }
        `,
      {
        input: [
          {
            filename,
            mimeType,
            httpMethod: "POST",
            resource: "FILE",
          },
        ],
      },
    );

    const stagedErrors =
      stagedData?.data?.stagedUploadsCreate?.userErrors || [];

    if (stagedErrors.length) {
      throw new Error(stagedErrors[0].message);
    }

    const target = stagedData?.data?.stagedUploadsCreate?.stagedTargets?.[0];

    if (!target) {
      throw new Error("Failed to create staged upload target");
    }

    // 2. Convert data URL to Blob
    const fileResponse = await fetch(file);
    const blob = await fileResponse.blob();

    // 3. Upload to staged target
    const formData = new FormData();

    target.parameters.forEach((param) => {
      formData.append(param.name, param.value);
    });

    formData.append("file", blob, filename);

    const uploadRes = await fetch(target.url, {
      method: "POST",
      body: formData,
    });

    if (!uploadRes.ok) {
      const text = await uploadRes.text();
      throw new Error(`Failed to upload file: ${text}`);
    }

    // 4. Create Shopify File
    const fileCreateData = await shopifyGraphQL(
      shop,
      token,
      version,
      `
          mutation fileCreate($files: [FileCreateInput!]!) {
            fileCreate(files: $files) {
              files {
                id
                fileStatus
  
                ... on MediaImage {
                  image {
                    url
                  }
                  preview {
                    image {
                      url
                    }
                  }
                }
  
                ... on GenericFile {
                  url
                }
              }
  
              userErrors {
                field
                message
              }
            }
          }
        `,
      {
        files: [
          {
            originalSource: target.resourceUrl,
            contentType,
          },
        ],
      },
    );

    const createErrors = fileCreateData?.data?.fileCreate?.userErrors || [];

    if (createErrors.length) {
      throw new Error(createErrors[0].message);
    }

    const createdFile = fileCreateData?.data?.fileCreate?.files?.[0];

    if (!createdFile?.id) {
      throw new Error("File created but no ID returned");
    }

    const fileId = createdFile.id;

    // 5. Poll until READY
    let finalUrl = null;

    for (let i = 0; i < 10; i++) {
      await sleep(1500);

      const pollData = await shopifyGraphQL(
        shop,
        token,
        version,
        `
            query getFile($id: ID!) {
              node(id: $id) {
                ... on MediaImage {
                  id
                  fileStatus
                  image {
                    url
                  }
                  preview {
                    image {
                      url
                    }
                  }
                }
  
                ... on GenericFile {
                  id
                  fileStatus
                  url
                }
              }
            }
          `,
        {
          id: fileId,
        },
      );

      const node = pollData?.data?.node;

      finalUrl = node?.image?.url || node?.preview?.image?.url || node?.url;

      if (finalUrl) {
        break;
      }
    }

    if (!finalUrl) {
      throw new Error("File uploaded but URL was not ready in time");
    }

    return Response.json(
      {
        url: finalUrl,
      },
      {
        headers: CORS_HEADERS,
      },
    );
  } catch (error) {
    console.error("Upload error:", error);

    return Response.json(
      {
        error: error.message || "Upload failed",
        stack: error.stack,
      },
      {
        status: 500,
        headers: CORS_HEADERS,
      },
    );
  }
}
