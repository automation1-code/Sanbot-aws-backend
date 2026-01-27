FROM python:3.11-slim

WORKDIR /app

# Install system deps for livekit-rtc (needs libsndfile for audio processing)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy agent code
COPY agent.py crm_functions.py heygen_byoli.py ./

# LiveKit agent runs as a worker process (not a web server).
# It connects outbound to LiveKit Cloud — no ports need to be exposed.
CMD ["python", "agent.py", "start"]
