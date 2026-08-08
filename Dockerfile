FROM python:3.12-slim

WORKDIR /app

COPY collector/collector.py .
COPY frontend/ ./frontend/

EXPOSE 7788

CMD ["python", "-u", "collector.py"]
