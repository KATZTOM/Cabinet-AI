import sys
import json
import os
import re
import math
import itertools

class Gravity3DPacker:
    def __init__(self):
        # Allow 1.0" length overhang on standard pallets (supports up to 49" boxes)
        self.std_spec = {"name": "Standard Pallet", "L": 48.0, "W": 40.0, "max_H": 70.0, "max_W": 1600.0, "overhang_L": 1.0, "overhang_W": 0.0}
        self.long_spec = {"name": "Long Pallet", "L": 96.0, "W": 40.0, "max_H": 70.0, "max_W": 1900.0, "overhang_L": 2.0, "overhang_W": 0.0}

    def intersect(self, b1, b2):
        eps = 0.001
        return not (b1['x'] + b1['dx'] <= b2['x'] + eps or b2['x'] + b2['dx'] <= b1['x'] + eps or
                    b1['y'] + b1['dy'] <= b2['y'] + eps or b2['y'] + b2['dy'] <= b1['y'] + eps or
                    b1['z'] + b1['dz'] <= b2['z'] + eps or b2['z'] + b2['dz'] <= b1['z'] + eps)

    def consolidate_long_accessories(self, long_items):
        if not long_items:
            return []
        
        total_weight = sum(item["weight"] for item in long_items)
        max_len = max(item["L"] for item in long_items)
        
        master_bundle = {
            "sku": "MASTER-BUNDLE-ACC", 
            "L": max_len, 
            "W": 18.0, 
            "H": 6.0, 
            "weight": total_weight,
            "cat": "long_acc_bundle",
            "orig_L": max_len, "orig_W": 18.0, "orig_H": 6.0,
            "unit_weight": total_weight, "dim_source": "master_bundle", "wt_source": "aggregated"
        }
        return [master_bundle]

    def force_place_box(self, pallet, box):
        """Emergency override to guarantee zero item loss under any constraint failure."""
        max_z = max([pb['z'] + pb['dz'] for pb in pallet["packed_boxes"]], default=0.0)
        pallet["packed_boxes"].append({
            "sku": box["sku"].upper(),
            "x": 0.0, "y": 0.0, "z": max_z,
            "dx": box["L"], "dy": box["W"], "dz": box["H"],
            "orig_L": box["orig_L"], "orig_W": box["orig_W"], "orig_H": box["orig_H"],
            "unit_weight": box["unit_weight"], "dim_source": box["dim_source"], "wt_source": box["wt_source"],
            "u_axis": "+X", "v_axis": "+Y", "w_axis": "+Z",
            "cat": box.get("cat", "cabinet"),
            "_raw_box": box
        })
        pallet["current_weight"] += box["weight"]

    def try_pack_box(self, pallet, box, custom_max_h=70.0, is_assembled_mode=False, force_lie_flat=False):
        spec = pallet["spec"]
        if pallet["current_weight"] + box["weight"] > spec["max_W"]:
            return False

        allowed_W = spec["W"] + (0.0 if is_assembled_mode else spec.get("overhang_W", 0.0))
        allowed_L = spec["L"] + (0.0 if (is_assembled_mode and spec["L"] == 48.0) else spec.get("overhang_L", 0.0))
        sku = box["sku"].upper()

        if box.get("cat") == "panel":
            dims = sorted([box["L"], box["W"], box["H"]])
            thickness = dims[0]
            panel_h   = dims[1]
            panel_l   = dims[2]

            if panel_h <= custom_max_h and panel_l <= allowed_L:
                dx = panel_l
                dy = thickness
                dz = panel_h

                existing_panels_dy = sum(pb['dy'] for pb in pallet["packed_boxes"] if pb.get('cat') == 'panel' and abs(pb['z']) < 0.01)
                y_pos = existing_panels_dy

                if y_pos + dy <= allowed_W:
                    test_box = {'x': 0.0, 'y': y_pos, 'z': 0.0, 'dx': dx, 'dy': dy, 'dz': dz}
                    if not any(self.intersect(test_box, pb) for pb in pallet["packed_boxes"]):
                        pallet["packed_boxes"].append({
                            "sku": sku, "x": 0.0, "y": y_pos, "z": 0.0,
                            "dx": dx, "dy": dy, "dz": dz,
                            "orig_L": box["orig_L"], "orig_W": box["orig_W"], "orig_H": box["orig_H"], 
                            "unit_weight": box["unit_weight"], "dim_source": box["dim_source"], "wt_source": box["wt_source"],
                            "u_axis": "+X", "v_axis": "+Z", "w_axis": "+Y",
                            "cat": "panel",
                            "_raw_box": box
                        })
                        pallet["current_weight"] += box["weight"]
                        return True
            return False

        if is_assembled_mode:
            cat = box.get("cat", "cabinet")
            if cat == "pantry_oven":
                orientations = [(box["L"], box["W"], box["H"], "+Y", "+X", "+Z")]
            elif cat == "cabinet":
                orientations = [
                    (box["W"], box["L"], box["H"], "+X", "+Z", "+Y"),
                    (box["L"], box["W"], box["H"], "+Y", "+Z", "+X")
                ]
            else:
                orientations = [
                    (box["L"], box["W"], box["H"], "+X", "+Z", "+Y"),
                    (box["W"], box["L"], box["H"], "+Y", "+Z", "+X")
                ]
        elif force_lie_flat:
            min_dim = min(box["L"], box["W"], box["H"])
            dims = [box["L"], box["W"], box["H"]]
            orientations = []
            seen = set()
            for dx, dy, dz in itertools.permutations(dims):
                if abs(dz - min_dim) < 0.01 and (dx, dy, dz) not in seen:
                    seen.add((dx, dy, dz))
                    orientations.append((dx, dy, dz, "+X", "+Z", "+Y"))
        else:
            dims = [box["L"], box["W"], box["H"]]
            orientations = []
            seen = set()
            for dx, dy, dz in itertools.permutations(dims):
                if (dx, dy, dz) not in seen:
                    seen.add((dx, dy, dz))
                    if dz <= max(dx, dy) * 2.5:
                        orientations.append((dx, dy, dz, "+X", "+Z", "+Y"))

        panel_y_boundary = max([pb['y'] + pb['dy'] for pb in pallet["packed_boxes"] if pb.get('cat') == 'panel'], default=0.0)

        unique_candidates = set([(0.0, panel_y_boundary, 0.0)])
        for b in pallet["packed_boxes"]:
            unique_candidates.add((b['x'] + b['dx'], b['y'], b['z']))
            unique_candidates.add((b['x'], b['y'] + b['dy'], b['z']))
            unique_candidates.add((b['x'], b['y'], b['z'] + b['dz']))
            unique_candidates.add((b['x'] + b['dx'], panel_y_boundary, 0.0))
            unique_candidates.add((0.0, b['y'] + b['dy'], 0.0))

        candidates = list(unique_candidates)
        valid_placements = []
        current_global_max_h = max([pb['z'] + pb['dz'] for pb in pallet["packed_boxes"]], default=0.0)

        plane_tolerance = 0.01 if is_assembled_mode else 4.0
        min_support_ratio = 0.90 if is_assembled_mode else 0.15

        for x, y, z in candidates:
            if x < 0.0 or y < panel_y_boundary or z < 0.0: continue

            for dx, dy, dz, u_axis, v_axis, w_axis in orientations:
                if x + dx > allowed_L + 0.001 or y + dy > allowed_W + 0.001 or z + dz > custom_max_h:
                    continue

                test_box = {'x': x, 'y': y, 'z': z, 'dx': dx, 'dy': dy, 'dz': dz}
                if any(self.intersect(test_box, pb) for pb in pallet["packed_boxes"]):
                    continue

                if z > 0:
                    box_base_area = dx * dy
                    supported_area = 0.0
                    for pb in pallet["packed_boxes"]:
                        if abs((pb['z'] + pb['dz']) - z) <= plane_tolerance:
                            x_overlap = max(0.0, min(x + dx, pb['x'] + pb['dx']) - max(x, pb['x']))
                            y_overlap = max(0.0, min(y + dy, pb['y'] + pb['dy']) - max(y, pb['y']))
                            if x_overlap > 0.0 and y_overlap > 0.0:
                                supported_area += (x_overlap * y_overlap)
                    
                    if (supported_area / box_base_area) < min_support_ratio:
                        continue

                potential_global_max_h = max(current_global_max_h, z + dz)
                alignment_bonus = 0
                if abs(x - 0.0) < 0.01 or abs((x + dx) - allowed_L) < 0.01:
                    alignment_bonus += 250000
                if abs(y - panel_y_boundary) < 0.01 or abs((y + dy) - allowed_W) < 0.01:
                    alignment_bonus += 250000

                for pb in pallet["packed_boxes"]:
                    if abs((pb['z'] + pb['dz']) - z) <= plane_tolerance:
                        x_overlap = max(0.0, min(x + dx, pb['x'] + pb['dx']) - max(x, pb['x']))
                        y_overlap = max(0.0, min(y + dy, pb['y'] + pb['dy']) - max(y, pb['y']))
                        if x_overlap > 0 and y_overlap > 0:
                            if abs(x - pb['x']) < 0.01 or abs((x + dx) - (pb['x'] + pb['dx'])) < 0.01:
                                alignment_bonus += 150000
                            if abs(y - pb['y']) < 0.01 or abs((y + dy) - (pb['y'] + pb['dy'])) < 0.01:
                                alignment_bonus += 150000

                height_penalty = z * 500000 if not is_assembled_mode else 0
                sort_tuple = (height_penalty, potential_global_max_h, z + dz, -alignment_bonus, y, x)
                valid_placements.append((sort_tuple, x, y, z, dx, dy, dz, u_axis, v_axis, w_axis))

        if valid_placements:
            valid_placements.sort(key=lambda item: item[0])
            _, x, y, z, dx, dy, dz, u_axis, v_axis, w_axis = valid_placements[0]
            pallet["packed_boxes"].append({
                "sku": sku, "x": x, "y": y, "z": z, "dx": dx, "dy": dy, "dz": dz,
                "orig_L": box["orig_L"], "orig_W": box["orig_W"], "orig_H": box["orig_H"], 
                "unit_weight": box["unit_weight"], "dim_source": box["dim_source"], "wt_source": box["wt_source"],
                "u_axis": u_axis, "v_axis": v_axis, "w_axis": w_axis,
                "cat": box.get("cat", "cabinet"),
                "_raw_box": box
            })
            pallet["current_weight"] += box["weight"]
            return True

        return False

    def try_pack_all_on_single_pallet(self, boxes, spec, custom_max_h=70.0, is_assembled_mode=False, force_lie_flat=False):
        sorted_boxes = sorted(boxes, key=lambda x: (
            0 if (x["L"] * x["W"] >= 400.0 or x["cat"] in ["cabinet", "pantry_oven", "pantry_box"]) else 1,
            -max(x["L"], x["W"], x["H"]),
            -(x["L"] * x["W"]),
            -x["weight"]
        ))
        
        test_pallet = {"spec": spec, "packed_boxes": [], "current_weight": 0.0}
        for b in sorted_boxes:
            if not self.try_pack_box(test_pallet, b, custom_max_h=custom_max_h, is_assembled_mode=is_assembled_mode, force_lie_flat=force_lie_flat):
                return None
        return test_pallet

    def try_merge_long_and_small_pallets(self, pallets, custom_max_h=70.0, is_assembled_mode=False, force_lie_flat=False):
        if len(pallets) < 2:
            return pallets

        changed = True
        while changed:
            changed = False
            long_pallets = [p for p in pallets if p["spec"] == self.long_spec]
            std_pallets = [p for p in pallets if p["spec"] == self.std_spec]

            if not long_pallets or not std_pallets:
                break

            std_pallets.sort(key=lambda p: p["current_weight"])

            merged_std_id = None
            merged_long_id = None
            replacement_pallet = None

            for std_p in std_pallets:
                for long_p in long_pallets:
                    if long_p["current_weight"] + std_p["current_weight"] > self.long_spec["max_W"]:
                        continue

                    combined_boxes = [pb["_raw_box"] for pb in long_p["packed_boxes"]] + \
                                     [pb["_raw_box"] for pb in std_p["packed_boxes"]]

                    merged_p = self.try_pack_all_on_single_pallet(combined_boxes, self.long_spec, custom_max_h=custom_max_h, is_assembled_mode=is_assembled_mode, force_lie_flat=force_lie_flat)

                    if merged_p is not None:
                        merged_long_id = id(long_p)
                        merged_std_id = id(std_p)
                        replacement_pallet = merged_p
                        break
                if replacement_pallet is not None:
                    break

            if replacement_pallet is not None:
                pallets = [p for p in pallets if id(p) not in (merged_long_id, merged_std_id)]
                pallets.append(replacement_pallet)
                changed = True

        return pallets

    def execute_packing(self, items, is_assembled_mode=False, force_lie_flat=False, custom_max_h=70.0):
        unit_boxes = []

        for item in items:
            L, W, H = float(item["depth_in"]), float(item["width_in"]), float(item["height_in"])
            weight = float(item["weight_lbs"])
            qty = int(item["qty"])

            sku_upper = item["sku"].upper()
            is_real_panel = any(k in sku_upper for k in ["PANEL", "PANNEAU", "TABLERO"]) and not any(k in sku_upper for k in ["SM", "MOLDING", "COV", "CM", "BM", "OCM", "QRM", "LMR"])
            
            # STRICT CHECK: Pantry & Oven boxes are cabinet boxes, NOT accessories!
            is_pantry_or_cabinet = bool(re.search(r'(OC|P\d{4}|W\d|B\d|V\d)', sku_upper)) or sku_upper.endswith('-A') or sku_upper.endswith('-B')

            cat = item.get("cat", "cabinet")
            if max(L, W, H) >= 80.0 and min(L, W, H) < 3.0 and is_real_panel:
                cat = "panel"
            elif max(L, W, H) >= 80.0 and min(L, W, H) < 10.0 and not is_pantry_or_cabinet and cat not in ["pantry_oven", "pantry_box", "cabinet"]:
                cat = "long_acc"
            elif (max(L, W, H) < 15.0 or "CONSOLIDATED" in sku_upper or "SLIDE" in sku_upper or "SD-" in sku_upper or "TS-" in sku_upper) and not is_pantry_or_cabinet and cat not in ["pantry_oven", "pantry_box", "cabinet"]:
                cat = "small_acc"

            for _ in range(qty):
                unit_boxes.append({
                    "sku": item["sku"], "L": L, "W": W, "H": H, "weight": weight, "cat": cat,
                    "orig_L": item["orig_L"], "orig_W": item["orig_W"], "orig_H": item["orig_H"], 
                    "unit_weight": item["unit_weight"], "dim_source": item["dim_source"], "wt_source": item["wt_source"]
                })

        long_acc_items = [b for b in unit_boxes if b.get("cat") == "long_acc"]
        if long_acc_items:
            master_bundle = self.consolidate_long_accessories(long_acc_items)
            unit_boxes = [b for b in unit_boxes if b.get("cat") != "long_acc"] + master_bundle

        long_boxes = []
        std_boxes = []

        for b in unit_boxes:
            if max(b["L"], b["W"], b["H"]) > 49.0:
                long_boxes.append(b)
            else:
                std_boxes.append(b)

        std_boxes.sort(key=lambda x: (
            0 if (x["L"] * x["W"] >= 400.0 or x["cat"] in ["cabinet", "pantry_oven", "pantry_box"]) else 1,
            -(x["L"] * x["W"]),
            -(x["L"] * x["W"] * x["H"]),
            -x["weight"]
        ))

        long_boxes.sort(key=lambda x: -max(x["L"], x["W"], x["H"]))

        pallets = []

        for box in std_boxes:
            packed = False
            for p in pallets:
                if p["spec"] == self.std_spec and p["current_weight"] + box["weight"] <= p["spec"]["max_W"]:
                    if self.try_pack_box(p, box, custom_max_h=custom_max_h, is_assembled_mode=is_assembled_mode, force_lie_flat=force_lie_flat):
                        packed = True
                        break
            if not packed:
                new_p = {"spec": self.std_spec, "packed_boxes": [], "current_weight": 0.0}
                if self.try_pack_box(new_p, box, custom_max_h=custom_max_h, is_assembled_mode=is_assembled_mode, force_lie_flat=force_lie_flat):
                    pallets.append(new_p)
                else:
                    long_p = {"spec": self.long_spec, "packed_boxes": [], "current_weight": 0.0}
                    if not self.try_pack_box(long_p, box, custom_max_h=custom_max_h, is_assembled_mode=is_assembled_mode, force_lie_flat=force_lie_flat):
                        self.force_place_box(long_p, box)
                    pallets.append(long_p)

        for box in long_boxes:
            packed = False
            for p in pallets:
                if p["spec"] == self.long_spec and p["current_weight"] + box["weight"] <= p["spec"]["max_W"]:
                    if self.try_pack_box(p, box, custom_max_h=custom_max_h, is_assembled_mode=is_assembled_mode, force_lie_flat=force_lie_flat):
                        packed = True
                        break
            if not packed:
                extra_p = {"spec": self.long_spec, "packed_boxes": [], "current_weight": 0.0}
                if not self.try_pack_box(extra_p, box, custom_max_h=custom_max_h, is_assembled_mode=is_assembled_mode, force_lie_flat=force_lie_flat):
                    self.force_place_box(extra_p, box)
                pallets.append(extra_p)

        pallets = [p for p in pallets if len(p["packed_boxes"]) > 0]
        pallets = self.try_merge_long_and_small_pallets(pallets, custom_max_h=custom_max_h, is_assembled_mode=is_assembled_mode, force_lie_flat=force_lie_flat)

        return pallets

    def execute_packing_with_target(self, items, is_assembled_mode=False, force_lie_flat=False, custom_max_h=70.0, target_pallet_count=None):
        initial_pallets = self.execute_packing(items, is_assembled_mode=is_assembled_mode, force_lie_flat=force_lie_flat, custom_max_h=custom_max_h)

        if target_pallet_count is None or target_pallet_count <= 0 or len(initial_pallets) == target_pallet_count:
            return initial_pallets, f"Re-packed order into {len(initial_pallets)} pallet(s)."

        if target_pallet_count > len(initial_pallets):
            best_pallets = initial_pallets
            for test_h in range(int(custom_max_h) - 4, 18, -2):
                test_p = self.execute_packing(items, is_assembled_mode=is_assembled_mode, force_lie_flat=force_lie_flat, custom_max_h=float(test_h))
                if len(test_p) == target_pallet_count:
                    return test_p, f"Throttled pallet max height to ~{test_h}\" to spread order into exactly {target_pallet_count} pallets."
                if len(best_pallets) < len(test_p) <= target_pallet_count:
                    best_pallets = test_p
            return best_pallets, f"Spread across maximum achievable pallets ({len(best_pallets)}) toward target of {target_pallet_count}."

        if target_pallet_count < len(initial_pallets):
            if custom_max_h < 70.0:
                test_p = self.execute_packing(items, is_assembled_mode=is_assembled_mode, force_lie_flat=force_lie_flat, custom_max_h=70.0)
                if len(test_p) <= target_pallet_count:
                    return test_p, f"Increased height constraint to consolidated total down to {len(test_p)} pallet(s)."
            return initial_pallets, f"Cannot safely consolidate below {len(initial_pallets)} pallet(s) without exceeding physical limits."


def clean_and_standardize_sku_key(sku_str, preserve_pkg_suffix=True):
    s = str(sku_str).upper().strip()
    for prefix in ["DW", "SC", "GS", "BS", "SMS", "SJ", "CDSH"]:
        if s.startswith(prefix + "-"): s = s[len(prefix)+1:]
        elif s.startswith(prefix): s = s[len(prefix):]
    
    if s.startswith("AC-"): s = s[3:]
    elif s.startswith("AC") and len(s) > 2 and s[2] != 'C': s = s[2:]

    s = re.sub(r'\s*\d+\s*PCS', '', s)
    s = re.sub(r'\s*\d*\s*SET', '', s)
    s = s.replace("KIT", "")
    if s.startswith("VDB"): s = s.replace("VDB", "DB")
    if s.startswith("DVB"): s = s.replace("DVB", "DB")
    if s.startswith("QRM"): s = s.replace("QRM", "QR")
    if s.startswith("SLB"): s = s.replace("SLB", "BLS")

    if not preserve_pkg_suffix:
        s = re.sub(r'[-_\s]*[AB]$', '', s)
    s = re.sub(r'[\s\-\/\*\_\"\\\']', '', s)
    s = re.sub(r'W(\d+)', r'\1', s)
    return s

def parse_preassembled_spec(sku_str, color="DW"):
    s = str(sku_str).upper().strip()
    clean_base = re.sub(r'^(DW|SC|GS|BS|SMS|SJ|CDSH)-?', '', s)
    clean_base = re.sub(r'[-_\s]*[AB]$', '', clean_base, flags=re.IGNORECASE)
    clean_base = re.sub(r'[-_\s]*KIT$', '', clean_base, flags=re.IGNORECASE).strip()

    prefix = color + "-" if color and not is_no_color_sku(clean_base) else ""
    full_sku = f"{prefix}{clean_base}" if not clean_base.startswith(color) else clean_base

    if any(k in clean_base for k in ["SLIDE", "DRAWER SLIDE", "SD-", "TS-"]):
        return {"sku": full_sku, "W": 3.0, "D": 25.0, "H": 3.0, "cat": "small_acc"}
    if any(k in clean_base for k in ["COLUMN", "CORBEL", "POST", "VALANCE"]):
        return {"sku": full_sku, "W": 24.0, "D": 37.0, "H": 5.0, "cat": "small_acc"}
    if "BF6" in clean_base:
        return {"sku": full_sku, "W": 8.0, "D": 39.0, "H": 7.0, "cat": "small_acc"}
    if "BF3" in clean_base:
        return {"sku": full_sku, "W": 8.0, "D": 39.0, "H": 4.0, "cat": "small_acc"}
    if clean_base.startswith("WF") or "WALL FILLER" in clean_base:
        h_match = re.search(r'\d{2}', clean_base)
        h_val = float(h_match.group(0)) if h_match else 30.0
        return {"sku": full_sku, "W": 12.0, "D": h_val, "H": 3.0, "cat": "small_acc"}
    if any(k in clean_base for k in ["F396", "F696", "F3 96", "F6 96", "F1 1/2 96"]):
        w_val = 6.0 if ("696" in clean_base or "6 96" in clean_base) else 3.0
        return {"sku": full_sku, "W": w_val, "D": 96.0, "H": 0.75, "cat": "long_acc"}
    if clean_base in ["TK", "AC-TK"] or "TOE KICK" in clean_base:
        return {"sku": full_sku, "W": 6.0, "D": 97.0, "H": 5.0, "cat": "long_acc"}
    if any(m in clean_base for m in ["AC-SM", "QRM", "COV", "CM2", "CM4", "BM4", "OCM"]) or clean_base == "SM":
        return {"sku": full_sku, "W": 9.0, "D": 97.0, "H": 2.0, "cat": "long_acc"}
    if any(k in clean_base for k in ["PANEL", "PANNEAU", "TABLERO"]):
        w_val = 48.0 if "48" in clean_base else 24.0
        return {"sku": full_sku, "W": w_val, "D": 96.0, "H": 0.75, "cat": "panel"}

    W, D, H = 24.0, 24.0, 34.5

    if re.match(r'^P\d{4}', clean_base, re.I) or clean_base.startswith("OC") or "PANTRY" in clean_base or "OVEN" in clean_base:
        w_match = re.search(r'^(?:OC|P)(\d{2})', clean_base, re.I)
        h_match = re.search(r'(84|90|93|96)', clean_base)
        val_w = 31.5 if clean_base.startswith("OC") else (float(w_match.group(1)) if w_match else 30.0)
        val_h = float(h_match.group(1)) if h_match else (84.0 if clean_base.startswith("OC") else 90.0)
        return {"sku": full_sku, "W": val_w, "H": val_h, "D": 24.0, "cat": "pantry_oven"}
    elif clean_base.startswith("W"):
        D = 24.0 if any(k in clean_base for k in ["1224", "1524", "1824", "2124", "2424"]) else 12.0
        nums = re.findall(r'\d+', clean_base)
        if len(nums) >= 2:
            W, H = float(nums[0]), float(nums[1])
        elif len(nums) == 1:
            val = nums[0]
            if len(val) == 4:
                W, H = float(val[:2]), float(val[2:])
            elif len(val) == 3:
                W, H = float(val[:1]), float(val[1:])
        return {"sku": full_sku, "W": W, "H": H, "D": D, "cat": "cabinet"}
    elif clean_base.startswith("V"):
        D = 21.0
        H = 34.5
        nums = re.search(r'\d+', clean_base)
        W = float(nums.group(0)) if nums else 24.0
        return {"sku": full_sku, "W": W, "H": H, "D": D, "cat": "cabinet"}
    elif clean_base.startswith("B"):
        if clean_base.startswith("BLS"):
            nums = re.search(r'\d+', clean_base)
            W = float(nums.group(0)) if nums else 36.0
            D = W
        else:
            D = 24.0
            nums = re.search(r'\d+', clean_base)
            W = float(nums.group(0)) if nums else 24.0
        H = 34.5
        return {"sku": full_sku, "W": W, "H": H, "D": D, "cat": "cabinet"}

    return {"sku": full_sku, "W": W, "H": H, "D": D, "cat": "cabinet"}

def is_no_color_sku(sku_str):
    s = str(sku_str).upper().strip()
    clean = re.sub(r'^(DW|SC|GS|BS|SMS|SJ|CDSH)-?', '', s)
    return bool(re.search(r'^(LSK|TS-|TS\d|SD-|SD\d|SLIDE|DRAWER SLIDE|HARDWARE)', clean))

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No input file provided"}))
        sys.exit(1)

    input_file = sys.argv[1]
    if not os.path.exists(input_file):
        print(json.dumps({"error": f"Input file not found: {input_file}"}))
        sys.exit(1)

    try:
        with open(input_file, 'r', encoding='utf-8') as f:
            raw_payload = json.load(f)

        items_input = raw_payload.get("items", []) if isinstance(raw_payload, dict) else raw_payload
        assembly_mode = raw_payload.get("assembly_mode", "flat_pack") if isinstance(raw_payload, dict) else "flat_pack"
        is_assembled = (assembly_mode == "assembled")

        ai_config = raw_payload.get("ai_config", {}) if isinstance(raw_payload, dict) else {}
        force_lie_flat = bool(ai_config.get("force_lie_flat", False))
        custom_max_h = float(ai_config.get("custom_max_h", 70.0))
        target_pallet_count = ai_config.get("target_pallet_count")
        if target_pallet_count is not None:
            try:
                target_pallet_count = int(target_pallet_count)
            except (ValueError, TypeError):
                target_pallet_count = None

        catalog_path = os.path.join(os.path.dirname(__file__), "catalog.json")
        catalog_map = {}
        if os.path.exists(catalog_path):
            with open(catalog_path, 'r', encoding='utf-8-sig') as cat_f:
                try:
                    cat_data = json.load(cat_f)
                    for item in cat_data:
                        raw_sku = str(item.get("sku", "")).upper().strip()
                        clean_k = clean_and_standardize_sku_key(raw_sku, preserve_pkg_suffix=True)
                        dims = item.get("dimensions", {})
                        assembled_dims = item.get("assembled_dimensions", {})

                        catalog_entry = {
                            "depth": float(dims["length_in"]) if dims.get("length_in") is not None else None,
                            "width": float(dims["width_in"]) if dims.get("width_in") is not None else None,
                            "height": float(dims["height_in"]) if dims.get("height_in") is not None else None,
                            "assembled_width": float(assembled_dims["width_in"]) if assembled_dims.get("width_in") is not None else None,
                            "assembled_depth": float(assembled_dims["depth_in"]) if assembled_dims.get("depth_in") is not None else None,
                            "assembled_height": float(assembled_dims["height_in"]) if assembled_dims.get("height_in") is not None else None,
                            "weight": float(item["weight_lbs"]) if item.get("weight_lbs") is not None else None,
                            "pcs_per_box": int(item.get("pcs_per_box", 1))
                        }
                        catalog_map[clean_k] = catalog_entry
                        catalog_map[f"AC{clean_k}"] = catalog_entry
                except Exception:
                    pass

        computed_order = []
        for row in items_input:
            color = row.get("color", "").strip()
            base_sku = row.get("sku", "").strip().upper()
            qty = int(row.get("qty", 0))
            if not base_sku or qty <= 0: continue

            is_cabinet_sku = bool(re.search(r'^(DW-|SC-|GS-|BS-|SMS-|SJ-)?(OC|P\d|W\d|B\d|V\d)', base_sku, re.I)) or base_sku.endswith('-A') or base_sku.endswith('-B')
            is_molding = (not is_cabinet_sku) and (any(m in base_sku for m in ["AC-SM", "QRM", "COV", "CM2", "CM4", "BM4", "OCM", "SCRIBE"]) or base_sku == "SM")
            is_slide = any(k in base_sku for k in ["SLIDE", "DRAWER SLIDE", "SD-", "TS-"])

            clean_base_chk = clean_and_standardize_sku_key(base_sku, preserve_pkg_suffix=False)
            lookup_key = clean_and_standardize_sku_key(base_sku, preserve_pkg_suffix=(not is_assembled))

            match = catalog_map.get(base_sku) or catalog_map.get(lookup_key) or catalog_map.get(clean_base_chk)
            if not match:
                for k, v in catalog_map.items():
                    if lookup_key in k or k in lookup_key:
                        match = v
                        break

            if is_molding:
                pcs_per_box = int(match.get("pcs_per_box")) if (match and match.get("pcs_per_box") and int(match.get("pcs_per_box")) > 1) else 20
                num_boxes = math.ceil(qty / pcs_per_box)
                unit_wt = (match["weight"] * qty) / num_boxes if (match and match.get("weight")) else (6.94 * qty) / num_boxes
                computed_order.append({
                    "sku": f"{color}-{base_sku}" if (color and not base_sku.startswith(color) and not is_no_color_sku(base_sku)) else base_sku,
                    "qty": num_boxes, "weight_lbs": unit_wt, "depth_in": 97.0, "width_in": 9.0, "height_in": 2.0,
                    "orig_L": 97.0, "orig_W": 9.0, "orig_H": 2.0, "unit_weight": unit_wt, "dim_source": "molding_master_box", "wt_source": "catalog",
                    "cat": "long_acc"
                })
                continue

            if is_slide:
                pcs_per_box = int(match.get("pcs_per_box", 6)) if match else 6
                num_boxes = math.ceil(qty / pcs_per_box)
                box_wt = match["weight"] if (match and match.get("weight")) else 42.0
                computed_order.append({
                    "sku": f"{color}-{base_sku}" if (color and not base_sku.startswith(color) and not is_no_color_sku(base_sku)) else base_sku,
                    "qty": num_boxes, "weight_lbs": box_wt, "depth_in": 25.0, "width_in": 3.0, "height_in": 3.0,
                    "orig_L": 25.0, "orig_W": 3.0, "orig_H": 3.0, "unit_weight": box_wt, "dim_source": "slide_spec", "wt_source": "catalog",
                    "cat": "small_acc"
                })
                continue

            if is_assembled:
                spec = parse_preassembled_spec(base_sku, color)
                full_sku = spec["sku"]
                pcs_per_box = int(match.get("pcs_per_box", 1)) if match else 1

                if pcs_per_box > 1:
                    num_boxes = math.ceil(qty / pcs_per_box)
                    weight = (match["weight"] * qty) / num_boxes if (match and match.get("weight")) else float(row.get("weight_lbs", 6.94))
                else:
                    num_boxes = qty
                    weight = match["weight"] if (match and match.get("weight")) else float(row.get("weight_lbs", 65.0))

                is_pantry_or_oven = (spec.get("cat") == "pantry_oven")

                if is_pantry_or_oven:
                    depth, width, height = spec["H"], spec["W"], spec["D"]
                    dim_source = "assembled_flat_spec"
                elif match and match.get("assembled_depth") and match.get("assembled_width") and match.get("assembled_height"):
                    depth, width, height = match["assembled_depth"], match["assembled_width"], match["assembled_height"]
                    dim_source = "catalog_assembled"
                else:
                    depth, width, height = spec["D"], spec["W"], spec["H"]
                    dim_source = "assembled_spec"

                computed_order.append({
                    "sku": full_sku, "qty": num_boxes, "weight_lbs": weight, "depth_in": depth, "width_in": width, "height_in": height,
                    "orig_L": spec["D"], "orig_W": spec["W"], "orig_H": spec["H"], "unit_weight": weight, "dim_source": dim_source, "wt_source": "catalog",
                    "cat": spec.get("cat", "cabinet")
                })
            else:
                full_sku = f"{color}-{base_sku}" if (color and not base_sku.startswith(color) and not is_no_color_sku(base_sku)) else base_sku
                pcs_per_box = int(match.get("pcs_per_box", 1)) if match else 1

                if match and match.get("depth") and match.get("width") and match.get("height"):
                    depth, width, height = match["depth"], match["width"], match["height"]
                    dim_source = "catalog"
                else:
                    is_long_b = lookup_key.endswith("B") or "96" in lookup_key
                    depth = 96.0 if is_long_b else 36.0
                    width = 24.0 if is_long_b else 30.0
                    height = 5.0 if is_long_b else 6.0
                    dim_source = "guessed"

                unit_wt = match["weight"] if (match and match.get("weight")) else width * 1.5
                wt_source = "catalog" if (match and match.get("weight")) else "guessed"

                # Tag explicit pantry & oven split boxes as pantry_box so they stay discrete
                item_cat = "pantry_box" if (base_sku.endswith('-A') or base_sku.endswith('-B') or re.search(r'^(P\d|OC)', base_sku)) else "cabinet"

                if pcs_per_box > 1:
                    num_boxes = math.ceil(qty / pcs_per_box)
                    weight_per_box = (unit_wt * qty) / num_boxes
                    computed_order.append({
                        "sku": full_sku, "qty": num_boxes, "weight_lbs": weight_per_box,
                        "depth_in": depth, "width_in": width, "height_in": height,
                        "orig_L": depth, "orig_W": width, "orig_H": height, "unit_weight": weight_per_box,
                        "dim_source": dim_source, "wt_source": wt_source, "cat": item_cat
                    })
                else:
                    computed_order.append({
                        "sku": full_sku, "qty": qty, "weight_lbs": unit_wt,
                        "depth_in": depth, "width_in": width, "height_in": height,
                        "orig_L": depth, "orig_W": width, "orig_H": height, "unit_weight": unit_wt,
                        "dim_source": dim_source, "wt_source": wt_source, "cat": item_cat
                    })

        packer = Gravity3DPacker()
        pallets_result, explanation = packer.execute_packing_with_target(
            computed_order, 
            is_assembled_mode=is_assembled, 
            force_lie_flat=force_lie_flat, 
            custom_max_h=custom_max_h,
            target_pallet_count=target_pallet_count
        )

        output_pallets = []
        for idx, p in enumerate(pallets_result):
            spec = p["spec"]
            max_h = max([box["z"] + box["dz"] for box in p["packed_boxes"]], default=0.0)
            allowed_W = spec["W"] + spec.get("overhang_W", 0.0)

            clean_boxes = [ {k: v for k, v in box.items() if k != "_raw_box"} for box in p["packed_boxes"] ]

            output_pallets.append({
                "pallet_id": idx + 1,
                "dimension": f"{int(spec['L'])} × {int(allowed_W)} × {int(max_h)}",
                "weight": f"{int(p['current_weight'])} lbs",
                "spec": spec,
                "boxes": clean_boxes
            })

        print(json.dumps({
            "pallets": output_pallets,
            "ai_explanation": explanation
        }))

    except Exception as e:
        print(json.dumps({"error": str(e)}))

if __name__ == "__main__":
    main()