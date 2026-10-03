import logging
import os
from typing import Any, Dict, Optional

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

log = logging.getLogger("shar.s3")


def _as_bool(value: Optional[str]) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


class S3Storage:
    def __init__(self) -> None:
        self.enabled = _as_bool(os.getenv("S3_ENABLED"))
        self.endpoint = os.getenv("S3_ENDPOINT", "https://storage.yandexcloud.net")
        self.region = os.getenv("S3_REGION", "ru-central1")
        self.bucket = os.getenv("S3_BUCKET", "").strip()
        self._client = None

        if not self.enabled:
            return

        access_key = os.getenv("S3_ACCESS_KEY", "").strip()
        secret_key = os.getenv("S3_SECRET_KEY", "").strip()
        if not self.bucket or not access_key or not secret_key:
            self.enabled = False
            return

        self._client = boto3.client(
            "s3",
            endpoint_url=self.endpoint,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name=self.region,
            config=Config(signature_version="s3v4"),
        )

    def upload_fileobj(self, file_obj, key: str, content_type: Optional[str] = None) -> int:
        if not self.enabled or self._client is None:
            raise RuntimeError("S3 storage is not enabled")

        # Seek to beginning — SpooledTemporaryFile may be at EOF after FastAPI reads multipart body
        if hasattr(file_obj, "seek"):
            try:
                file_obj.seek(0)
            except Exception:
                pass

        put_kwargs: Dict[str, Any] = {
            "Bucket": self.bucket,
            "Key": key,
            "Body": file_obj,
            "ACL": "public-read",
        }
        if content_type:
            put_kwargs["ContentType"] = content_type

        self._client.put_object(**put_kwargs)
        head = self._client.head_object(Bucket=self.bucket, Key=key)
        return int(head.get("ContentLength", 0))

    def generate_presigned_put_url(self, key: str, content_type: str, expires_in: int = 3600) -> str:
        """Generate a presigned URL for direct client-to-S3 PUT upload."""
        if not self.enabled or self._client is None:
            raise RuntimeError("S3 storage is not enabled")
        return self._client.generate_presigned_url(
            "put_object",
            Params={
                "Bucket": self.bucket,
                "Key": key,
                "ContentType": content_type,
            },
            ExpiresIn=expires_in,
        )

    def generate_presigned_get_url(self, key: str, expires_in: int = 3600) -> str:
        """Generate a presigned URL for GET access to a private S3 object."""
        if not self.enabled or self._client is None:
            raise RuntimeError("S3 storage is not enabled")
        return self._client.generate_presigned_url(
            "get_object",
            Params={"Bucket": self.bucket, "Key": key},
            ExpiresIn=expires_in,
        )

    def set_public_acl(self, key: str) -> None:
        """Set public-read ACL on an existing object (called after presigned upload)."""
        if not self.enabled or self._client is None:
            return
        try:
            self._client.put_object_acl(
                Bucket=self.bucket,
                Key=key,
                ACL="public-read",
            )
        except ClientError as exc:
            # Log but don't raise — object exists even if ACL fails (e.g. bucket policy already public)
            log.warning("could not set public-read ACL on %s: %s", key, exc)

    def get_object(self, key: str) -> Optional[Dict[str, Any]]:
        if not self.enabled or self._client is None:
            return None

        try:
            return self._client.get_object(Bucket=self.bucket, Key=key)
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code")
            if code in {"NoSuchKey", "404", "NotFound"}:
                return None
            raise

    def public_url(self, key: str) -> str:
        """Return the public URL for an object key (assumes bucket is publicly readable)."""
        endpoint = self.endpoint.rstrip("/")
        return f"{endpoint}/{self.bucket}/{key}"

    def delete_object(self, key: str) -> bool:
        if not self.enabled or self._client is None:
            return False
        try:
            self._client.delete_object(Bucket=self.bucket, Key=key)
            return True
        except ClientError:
            return False

    def delete_prefix(self, prefix: str) -> int:
        if not self.enabled or self._client is None:
            return 0

        paginator = self._client.get_paginator("list_objects_v2")
        deleted = 0
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix):
            objects = page.get("Contents", [])
            if not objects:
                continue
            payload = {"Objects": [{"Key": obj["Key"]} for obj in objects]}
            self._client.delete_objects(Bucket=self.bucket, Delete=payload)
            deleted += len(objects)
        return deleted
