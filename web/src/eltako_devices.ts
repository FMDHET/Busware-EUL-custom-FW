// Eltako-Funkgeräte -> EEP-Zuordnung.
//
// Kuratierte Liste gängiger Eltako-FUNK-Produkte (Sender), die als "Absender"
// auf einem Funk-Gateway (TCM515) erscheinen. Die EEP-Zuordnungen stützen sich
// auf die KeyFunction-Tabelle der eltako14bus-Bibliothek (z.B. FUTH -> A5-10-12,
// FTR55D -> A5-10-06, FWG14MS -> A5-13-01) sowie etablierte EnOcean-Profile für
// Taster (F6-02-01) und Fensterkontakte (D5-00-01).
//
// Ist ein Gerät hier ausgewählt, setzt das Portal automatisch das passende EEP
// (Spalte "EEP-Profil"). Die Liste ist bewusst erweiterbar - Eltako führt weit
// mehr Artikel; hier stehen die verbreiteten Funk-Sender. Nur EEPs verwenden,
// die auch im EEP-Katalog vorkommen (sonst keine "Bedeutung"-Dekodierung).

export interface EltakoDevice {
    model: string; // Artikel-/Modellbezeichnung
    desc: string;  // Kurzbeschreibung
    eep: string;   // zugehöriges EEP
}

export const ELTAKO_DEVICES: EltakoDevice[] = [
    // --- Funktaster / Wippen / Handsender (RPS, F6-02-01) --------------------
    { model: 'FT55', desc: 'Funktaster 55x55, 2 Wippen', eep: 'F6-02-01' },
    { model: 'F4T55E', desc: 'Funktaster 4-fach 55x55', eep: 'F6-02-01' },
    { model: 'F2T55E', desc: 'Funktaster 2-fach 55x55', eep: 'F6-02-01' },
    { model: 'FT4F', desc: 'Funktaster 4-fach Flush', eep: 'F6-02-01' },
    { model: 'FT2PL', desc: 'Funktaster 2-fach im Plexiglas', eep: 'F6-02-01' },
    { model: 'FT4PL', desc: 'Funktaster 4-fach im Plexiglas', eep: 'F6-02-01' },
    { model: 'FMH2S', desc: 'Funk-Minihandsender 2 Tasten', eep: 'F6-02-01' },
    { model: 'FMH4S', desc: 'Funk-Minihandsender 4 Tasten', eep: 'F6-02-01' },
    { model: 'FHS8', desc: 'Funk-Handsender 8 Tasten', eep: 'F6-02-01' },
    { model: 'FSS12', desc: 'Funk-Schnurschalter', eep: 'F6-02-01' },
    { model: 'FGB55', desc: 'Funk-Glastaster 55x55', eep: 'F6-02-01' },

    // --- Fenster-/Türkontakte, Griffe (1BS D5-00-01 / A5-14) ----------------
    { model: 'FTK', desc: 'Fenster-Tür-Kontakt', eep: 'D5-00-01' },
    { model: 'FTKB', desc: 'Fenster-Tür-Kontakt batterielos', eep: 'D5-00-01' },
    { model: 'TF-FKB', desc: 'Tarnfarben Fenster-Kontakt batterielos', eep: 'D5-00-01' },
    { model: 'FFT', desc: 'Funk-Fenster-Tür-Sensor', eep: 'D5-00-01' },
    { model: 'FGH', desc: 'Funk-Griff-Sensor (Fenstergriff)', eep: 'A5-14-09' },

    // --- Bewegung / Präsenz / Helligkeit (A5-07 / A5-08 / A5-06) ------------
    { model: 'FBH55', desc: 'Funk-Bewegung-Helligkeit 55x55', eep: 'A5-08-01' },
    { model: 'FBH65', desc: 'Funk-Bewegung-Helligkeit', eep: 'A5-08-01' },
    { model: 'FBH65S', desc: 'Funk-Bewegung-Helligkeit (Decke)', eep: 'A5-08-01' },
    { model: 'FBH65TF', desc: 'Funk-Bewegung-Helligkeit Tarnfarben', eep: 'A5-08-01' },
    { model: 'FBH63', desc: 'Funk-Bewegungsmelder', eep: 'A5-07-01' },
    { model: 'FAH60', desc: 'Funk-Außenhelligkeitssensor', eep: 'A5-06-01' },
    { model: 'FAH65', desc: 'Funk-Helligkeitssensor', eep: 'A5-06-01' },
    { model: 'FIH65', desc: 'Funk-Innenhelligkeitssensor', eep: 'A5-06-01' },

    // --- Temperatur / Feuchte / Raumbedienung (A5-02 / A5-04 / A5-10) -------
    { model: 'FTF55', desc: 'Funk-Temperaturfühler 55x55', eep: 'A5-02-05' },
    { model: 'FTF65', desc: 'Funk-Temperaturfühler', eep: 'A5-02-05' },
    { model: 'FTR55D', desc: 'Funk-Temperaturregler 55x55', eep: 'A5-10-06' },
    { model: 'FTR65DS', desc: 'Funk-Temperaturregler Display', eep: 'A5-10-06' },
    { model: 'FTR65HS', desc: 'Funk-Temperaturregler', eep: 'A5-10-03' },
    { model: 'FUTH65D', desc: 'Funk-Uhrenthermostat + Feuchte', eep: 'A5-10-12' },
    { model: 'FFT65B', desc: 'Funk-Feuchte-Temperatur-Sensor', eep: 'A5-04-02' },

    // --- Wetter / Umwelt (A5-13) --------------------------------------------
    { model: 'FWS61', desc: 'Funk-Wetterstation', eep: 'A5-13-01' },
    { model: 'FWS81', desc: 'Funk-Wetterstation', eep: 'A5-13-01' },
    { model: 'MS', desc: 'Multisensor (Wetter)', eep: 'A5-13-01' },
    { model: 'FWG65', desc: 'Funk-Wettersensor', eep: 'A5-13-01' },

    // --- Energie / Zähler (A5-12) -------------------------------------------
    { model: 'FWZ65-3A', desc: 'Funk-Wechselstromzähler', eep: 'A5-12-01' },
    { model: 'FWZ12-16A', desc: 'Funk-Zwischenzähler', eep: 'A5-12-01' },
];
