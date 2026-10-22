# Backend image: FastAPI app + the pipeline scripts it shells out to.
# The whole repo is copied in because the backend runs scripts/*.py (and reads
# db/schema.sql + migrations) relative to the project root.
FROM python:3.12-slim

# ffmpeg is needed by the local audio-analysis step (librosa decoding).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8888
# Bind all interfaces inside the container; apply DB migrations on boot.
CMD ["sh", "-c", "python scripts/db_migrate.py && uvicorn main:app --app-dir web/backend --host 0.0.0.0 --port 8888"]
