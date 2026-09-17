FROM nycplanning/docker-geosupport:26.3.0@sha256:b549087cfe07910f8c71a561ead3a728160de0817914c495cc6b75e65815774b

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt ./
RUN python -m pip install --no-cache-dir -r requirements.txt \
    && useradd --create-home --uid 10001 resolver

COPY --chown=resolver:resolver resolver_service ./resolver_service
COPY --chown=resolver:resolver gunicorn.conf.py ./gunicorn.conf.py

USER resolver
EXPOSE 8080

CMD ["gunicorn", "--config", "gunicorn.conf.py", "resolver_service.wsgi:app"]
