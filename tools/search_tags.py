import csv
import sys
import os

# Base directory relative to this script
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSV_PATH = os.path.join(BASE_DIR, 'backend', 'selected_tags_ja.csv')

def search_tags(keyword):
    if not os.path.exists(CSV_PATH):
        print(f"Error: CSV file not found at {CSV_PATH}")
        return

    try:
        with open(CSV_PATH, mode='r', encoding='utf-8') as f:
            reader = csv.reader(f)
            header = next(reader)
            print(f"{'Line':<6} | {'Tag ID':<10} | {'Japanese Name':<20} | {'Cat':<3} | {'English Tag'}")
            print("-" * 70)
            
            for i, row in enumerate(reader, start=2):
                if len(row) < 5:
                    continue
                
                # Search in all columns except maybe count? 
                # Usually name (row 1) and original_en (row 4) are most important.
                if any(keyword.lower() in col.lower() for col in row):
                    line_info = f"{i:<6} | {row[0]:<10} | {row[1]:<20} | {row[2]:<3} | {row[4]}"
                    print(line_info)

    except Exception as e:
        print(f"Error during search: {e}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python tools/search_tags.py <keyword>")
        sys.exit(1)
    
    search_tags(sys.argv[1])
