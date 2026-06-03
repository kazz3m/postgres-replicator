from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    source_dsn: str = ""
    dest_dsn: str = ""
    stats_refresh_interval: int = 10  # seconds

    class Config:
        env_file = ".env"


settings = Settings()
