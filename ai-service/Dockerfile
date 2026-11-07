FROM python:3.11-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1
WORKDIR /app

COPY requirements.txt ./
# Install CPU-only PyTorch before sentence-transformers to avoid CUDA image bloat.
RUN python -m pip install --upgrade pip && \
    python -m pip install torch==2.9.1 --index-url https://download.pytorch.org/whl/cpu && \
    python -m pip install -r requirements.txt python-dotenv

COPY app/ ./app/
EXPOSE 8001
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001"]
