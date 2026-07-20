package com.sentum.evidencecomprehensive.service.handler;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description: 组合生成器 文献查询使用
 * DateTime: 2025/7/14
 */
public class IndexCombinationGenerator {
    private final List<Integer> lengths;
    private List<Integer> currentIndices;
    private boolean hasNext = true;

    public IndexCombinationGenerator(List<Integer> lengths) {
        this.lengths = lengths;
        this.currentIndices = new ArrayList<>(Collections.nCopies(lengths.size(), 0));
    }

    public boolean hasNext() {
        return hasNext;
    }

    public List<Integer> next() {
        List<Integer> result = new ArrayList<>(currentIndices);

        // 递增索引
        int i = lengths.size() - 1;
        while (i >= 0) {
            int nextVal = currentIndices.get(i) + 1;
            if (nextVal < lengths.get(i)) {
                currentIndices.set(i, nextVal);
                break;
            } else {
                currentIndices.set(i, 0);
                i--;
            }
        }
        if (i < 0) {
            hasNext = false; // 全部组合尝试完毕
        }

        return result;
    }
}
