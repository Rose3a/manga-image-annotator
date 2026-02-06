
import csv
from collections import defaultdict

file_path = r'c:\Users\yukku\OneDrive\画像\manga-ocr\backend\selected_tags_ja.csv'


import sys

output_file = 'analysis_results.txt'

with open(output_file, mode='w', encoding='utf-8') as out:
    ja_to_en = defaultdict(list)
    with open(file_path, mode='r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            ja_to_en[row['name']].append(row['original_en'])

    out.write("\n--- Targeted Search Results ---\n")
    with open(file_path, mode='r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            en = row['original_en']
            ja = row['name']
            
            # field/area check
            if 'field' in en or 'area' in en or 'sword' in en or 'sode' in en:
                out.write(f"Search match: {en} -> {ja}\n")

            # Mojibake check (common garbled chars)
            if any(ord(c) > 0x10000 for c in ja) or any(c in ja for c in ['', '']):
                out.write(f"Potential Mojibake: {en} -> {ja}\n")
