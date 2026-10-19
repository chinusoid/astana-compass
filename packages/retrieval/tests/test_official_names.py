from astana_retrieval.names import mentions, source_names, source_texts


def test_official_aliases_searchable_without_replacing_old_osm_names():
    place = {"name": "Астана саябағы", "description": "", "facts": [
        {"key": "name:ru", "status": "known", "value": "Парк Астана"},
        {"key": "official:aliases:ru", "status": "known", "value": ["Центральный парк"]},
        {"key": "official:aliases:kk", "status": "known", "value": ["Орталық қалалық саябақ"]},
        {"key": "official:description:ru", "status": "known", "value": "Прогулки по берегу Есиля."},
        {"key": "official:aliases:en", "status": "conflicting", "value": None},
        {"key": "official:visitor_note", "status": "known", "value": "Not a name or search description"},
    ]}
    aliases = source_names(place)
    assert mentions("хочу в центральный парк", aliases)[0].key == "official:aliases:ru"
    assert mentions("парк астана", aliases)[0].key == "name:ru"
    assert mentions("орталық қалалық саябақ", aliases)[0].key == "official:aliases:kk"
    assert ("Прогулки по берегу Есиля.", "official:description:ru") in source_texts(place)
    assert all("official:visitor_note" != key for _, key in source_texts(place))
