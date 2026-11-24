from __future__ import annotations

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sys
from tempfile import NamedTemporaryFile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

API_HOST = "https://eu.api.blizzard.com"
PROFILE_NAMESPACE = "profile-forever-eu"
STATIC_NAMESPACE = "static-forever-eu"
LOCALE = "en_GB"
GUILD_SLUG = "hearthbound"
GUILD_ID = 70159
WORKERS = 6
RETRYABLE_STATUS = {429, 500, 502, 503, 504}


def request_json(request: Request) -> dict:
    for attempt in range(3):
        try:
            with urlopen(request, timeout=20) as response:
                return json.load(response)
        except HTTPError as error:
            if attempt == 2 or error.code not in RETRYABLE_STATUS:
                raise
            retry_after = error.headers.get("Retry-After", "")
            delay = min(int(retry_after), 30) if retry_after.isdecimal() else 2 ** attempt
            error.close()
        except (URLError, TimeoutError):
            if attempt == 2:
                raise
            delay = 2 ** attempt
        time.sleep(delay)


class BlizzardClient:
    def __init__(self, token: str):
        self.token = token

    @classmethod
    def authenticate(cls, client_id: str, client_secret: str) -> BlizzardClient:
        credentials = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
        response = request_json(Request(
            "https://oauth.battle.net/token",
            data=b"grant_type=client_credentials",
            headers={
                "Authorization": f"Basic {credentials}",
                "Content-Type": "application/x-www-form-urlencoded",
            },
        ))
        return cls(response["access_token"])

    def get(self, path: str, namespace: str, *, missing_ok: bool = False) -> dict | None:
        query = urlencode({"namespace": namespace, "locale": LOCALE})
        request = Request(
            f"{API_HOST}{path}?{query}",
            headers={"Authorization": f"Bearer {self.token}"},
        )
        try:
            return request_json(request)
        except HTTPError as error:
            if error.code == 404 and missing_ok:
                error.close()
                return None
            raise


def get_professions(client: BlizzardClient, member: dict) -> dict | None:
    slug = quote(member["slug"], safe="")
    profile = client.get(
        f"/profile/wow/character/{slug}/professions",
        PROFILE_NAMESPACE,
        missing_ok=True,
    )
    if profile is not None and profile["character"]["id"] != member["id"]:
        raise ValueError(f"Profession profile returned an unexpected character ID for {slug}")
    return profile


def get_recipe_details(client: BlizzardClient, recipe_id: int) -> dict | None:
    details = client.get(
        f"/data/wow/recipe/{recipe_id}", STATIC_NAMESPACE, missing_ok=True
    )
    if details is not None and details["id"] != recipe_id:
        raise ValueError(f"Recipe details returned an unexpected ID for {recipe_id}")
    return details


def build_snapshot(client: BlizzardClient) -> dict:
    started_at = datetime.now(timezone.utc).replace(microsecond=0)
    roster = client.get(f"/data/wow/guild/{GUILD_SLUG}/roster", PROFILE_NAMESPACE)
    guild = roster["guild"]
    if guild["id"] != GUILD_ID or guild["faction"]["type"] != "HORDE":
        raise ValueError("Blizzard returned an unexpected Hearthbound guild identity")

    members = {}
    for entry in roster["members"]:
        character = entry["character"]
        members[character["id"]] = character
    if not members:
        raise ValueError("Blizzard returned an empty Hearthbound roster")

    recipes = {}
    available = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        profiles = pool.map(lambda member: get_professions(client, member), members.values())
        for member, profile in zip(members.values(), profiles, strict=True):
            if profile is None:
                continue
            available += 1
            for profession in profile.get("primaries", []) + profile.get("secondaries", []):
                for tier in profession.get("tiers", []):
                    for recipe in tier.get("known_recipes", []):
                        record = recipes.setdefault(recipe["id"], {
                            "id": recipe["id"],
                            "name": recipe["name"],
                            "profession": profession["profession"]["name"],
                            "crafter_ids": set(),
                        })
                        record["crafter_ids"].add(member["id"])

        if not recipes:
            raise ValueError("Blizzard returned no learned recipes across the guild roster")

        recipe_ids = sorted(recipes)
        details_batch = pool.map(lambda recipe_id: get_recipe_details(client, recipe_id), recipe_ids)
        entries = []
        for recipe_id, details in zip(recipe_ids, details_batch, strict=True):
            recipe = recipes[recipe_id]
            crafter_ids = recipe.pop("crafter_ids")
            crafters = sorted(
                (character_summary(members[member_id]) for member_id in crafter_ids),
                key=lambda character: (character["name"].casefold(), character["id"]),
            )
            reagents = details.get("reagents") if details else None
            entries.append({
                **recipe,
                "item": item_summary(details.get("crafted_item")) if details else None,
                "materials": [material_summary(reagent) for reagent in reagents]
                if reagents is not None else None,
                "details_available": details is not None,
                "crafters": crafters,
            })

    return {
        "schema_version": 1,
        "refreshed_at": started_at.isoformat(),
        "expires_at": (started_at + timedelta(days=30)).isoformat(),
        "guild": {"name": guild["name"], "id": guild["id"], "slug": GUILD_SLUG},
        "coverage": {"roster": len(members), "profiles_available": available},
        "recipes": entries,
    }


def character_summary(member: dict) -> dict:
    full_name = " ".join(filter(None, (member["name"], member.get("surname"))))
    return {"id": member["id"], "name": full_name, "slug": member["slug"]}


def item_summary(item: dict | None) -> dict | None:
    if item is None:
        return None
    return {"id": item["id"], "name": item["name"]}


def material_summary(reagent: dict) -> dict:
    return {
        "id": reagent["reagent"]["id"],
        "name": reagent["reagent"]["name"],
        "quantity": reagent["quantity"],
    }


def write_snapshot(path: Path, snapshot: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = None
    try:
        with NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent, delete=False
        ) as output:
            temporary_path = Path(output.name)
            json.dump(snapshot, output, ensure_ascii=False, separators=(",", ":"))
            output.write("\n")
        temporary_path.replace(path)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Refresh the Hearthbound crafting snapshot.")
    parser.add_argument("--output", type=Path, default=Path("local/catalog.json"))
    args = parser.parse_args()
    client_id = os.environ.get("BLIZZARD_CLIENT_ID")
    client_secret = os.environ.get("BLIZZARD_CLIENT_SECRET")
    if not client_id or not client_secret:
        parser.error("Set BLIZZARD_CLIENT_ID and BLIZZARD_CLIENT_SECRET in the environment.")
    try:
        client = BlizzardClient.authenticate(client_id, client_secret)
        snapshot = build_snapshot(client)
        write_snapshot(args.output, snapshot)
    except (URLError, TimeoutError, OSError, ValueError, KeyError, TypeError) as error:
        print(f"Refresh failed: {error}", file=sys.stderr)
        return 1
    coverage = snapshot["coverage"]
    details_available = sum(recipe["details_available"] for recipe in snapshot["recipes"])
    print(
        f"Saved {len(snapshot['recipes'])} recipe IDs ({details_available} with details) "
        f"from {coverage['profiles_available']} of {coverage['roster']} guild characters "
        f"to {args.output}."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
