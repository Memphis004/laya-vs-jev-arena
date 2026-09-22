# Human vs Jev arena: five browser games plus a tiny Python server that proxies Jev.
# No pip packages needed (stdlib only), so the image stays ~50 MB.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 \
    PORT=8732 \
    ENABLE_LAYA=0

WORKDIR /app
COPY server.py index.html ./
COPY shared ./shared
COPY snake ./snake
COPY fight ./fight
COPY runner ./runner
COPY flappy ./flappy
COPY tetris ./tetris

RUN useradd --no-create-home --shell /usr/sbin/nologin arena
USER arena

EXPOSE 8732
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request,os;urllib.request.urlopen('http://127.0.0.1:%s/api/config'%os.environ['PORT'])"
CMD ["python", "server.py"]
