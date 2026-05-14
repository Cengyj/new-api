/*
Copyright (C) 2025 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/

import { useEffect, useMemo, useState } from 'react';
import { API } from '../../helpers';
import { mergePricingIntoModels } from './creationModelAccess.js';

export function useCreationPricing(models) {
  const [pricingItems, setPricingItems] = useState([]);

  useEffect(() => {
    let cancelled = false;

    const loadPricing = async () => {
      try {
        const res = await API.get('/api/pricing');
        const { success, data } = res.data;
        if (!cancelled && success && Array.isArray(data)) {
          setPricingItems(data);
        }
      } catch {
        if (!cancelled) setPricingItems([]);
      }
    };

    void loadPricing();

    return () => {
      cancelled = true;
    };
  }, []);

  return useMemo(
    () => mergePricingIntoModels(models, pricingItems),
    [models, pricingItems],
  );
}
