FROM python:3.12-slim

WORKDIR /app

COPY collector.py .

EXPOSE 7788

CMD ["python", "-u", "collector.py"]