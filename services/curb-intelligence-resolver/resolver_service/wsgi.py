from .app import create_app
from .native_adapter import Geosupport26CAdapter
from .operational_logging import configure_for_gunicorn
from .service import ResolverService


# Gunicorn imports this module inside its worker when preload is disabled.
configure_for_gunicorn()
app = create_app(ResolverService(Geosupport26CAdapter()))
