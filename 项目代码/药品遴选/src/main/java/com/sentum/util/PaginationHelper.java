package com.sentum.util;

import java.util.ArrayList;
import java.util.List;

public class PaginationHelper<T> {
    private List<T> list;
    private int pageSize;

    public PaginationHelper(List<T> list, int pageSize) {
        this.list = list;
        this.pageSize = pageSize;
    }

    public List<T> getPage(int pageNumber) {
        int fromIndex = (pageNumber - 1) * pageSize;
        if (fromIndex >= list.size() || fromIndex < 0) {
            return new ArrayList<>(); // 如果超出范围，返回空列表
        }
        int toIndex = fromIndex + pageSize;
        if (toIndex > list.size()) {
            toIndex = list.size();
        }
        return list.subList(fromIndex, toIndex);
    }
}
