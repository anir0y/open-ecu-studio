FROM python:3.12-slim

WORKDIR /lab
COPY pyproject.toml /lab/
COPY ecu_lab /lab/ecu_lab
COPY firmware/reference_ecu /lab/firmware/reference_ecu
COPY tests /lab/tests
RUN pip install --no-cache-dir '.[test]'

CMD ["python", "-m", "ecu_lab.demo", "--interface", "virtual", "--channel", "docker-lab"]

