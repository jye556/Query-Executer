FROM python:3.11-slim-bookworm

# Install customer-database client libraries.  The Microsoft repository is
# pinned to the Debian major version of the base image so pyodbc has a real
# SQL Server driver at runtime rather than only the Python module.
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    libfbclient2 \
    unixodbc \
    unixodbc-dev \
    && curl -fsSL -o /tmp/packages-microsoft-prod.deb \
        https://packages.microsoft.com/config/debian/12/packages-microsoft-prod.deb \
    && dpkg -i /tmp/packages-microsoft-prod.deb \
    && rm /tmp/packages-microsoft-prod.deb \
    && apt-get update \
    && ACCEPT_EULA=Y DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends msodbcsql18 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8282

# Start the FastAPI application with live-reload support
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8282"]