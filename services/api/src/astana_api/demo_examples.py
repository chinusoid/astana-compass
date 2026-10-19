"""Runnable synthetic request examples; shapes still come from canonical contracts."""
from copy import deepcopy
from datetime import datetime
from importlib.resources import files
import json
from zoneinfo import ZoneInfo


def request_examples():
    cases = json.loads(files("astana_contracts").joinpath("data/contracts.examples.json").read_text(encoding="utf-8"))["cases"]
    base = deepcopy(next(case["instance"] for case in cases if case["name"] == "request_valid"))
    base["start_at"] = datetime.now(ZoneInfo("Asia/Almaty")).replace(microsecond=0).isoformat()

    def example(summary, description, **changes):
        return {"summary": summary, "description": description, "value": {**deepcopy(base), **changes}}

    return {
        "RecommendationRequest": {
            "indoor": example("Помещение на час", "Fixture mode: two synthetic indoor candidates. Coordinates are test data, not the user's location."),
            "unknown_required": example("Неизвестная доступность", "Fixture mode: no_match; unknown required wheelchair access cannot be assumed.", constraints=[{"key": "wheelchair_accessible", "value": True, "strength": "required"}]),
            "short_budget": example("Больше выбранного времени", "Fixture mode: partial; longer visits remain visible with an explicit time-overrun warning.", available_seconds=60),
            "unsupported_transport": example("Велосипед: ожидается 422", "The HTTP API currently implements walking only.", transport="cycling"),
        },
        "ItineraryRequest": {
            "two_stops": example("Две синтетические остановки", "Fixture mode only. Preserves the specified order, includes the return leg and checks the total budget.", place_ids=["synthetic:place:three", "synthetic:place:one"]),
        },
        "FeedbackRequest": {
            "helpful": {"summary": "Тестовый отзыв", "description": "Volatile process memory only; replace request_id with your response ID. Feedback is not used automatically for training.", "value": {"request_id": "synthetic:sandbox:feedback", "rating": "helpful", "comment": None}},
        },
    }
