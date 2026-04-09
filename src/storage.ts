import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { readFile } from "node:fs/promises";
import { v4 as uuidv4 } from "uuid";

function getClient(): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT!,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
}

function getBucket(): string {
  const bucket = process.env.R2_BUCKET;
  if (!bucket) throw new Error("R2_BUCKET environment variable is required");
  return bucket;
}

export async function uploadPdf(filePath: string): Promise<string> {
  const client = getClient();
  const bucket = getBucket();
  const key = `pdfs/${uuidv4()}.pdf`;
  const body = await readFile(filePath);

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "application/pdf",
    })
  );

  return key;
}

export async function getPresignedUrl(key: string): Promise<string> {
  const client = getClient();
  const bucket = getBucket();

  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: 3600 } // 1 hour
  );
}
