. ../../.env
echo $OPENAI_API_KEY
#OPENAI_API_KEY=$OPENAI_API_KEY python main.py
#
OPENAI_API_KEY=$OPENAI_API_KEY uvicorn server:app --host 0.0.0.0 --port 8000
