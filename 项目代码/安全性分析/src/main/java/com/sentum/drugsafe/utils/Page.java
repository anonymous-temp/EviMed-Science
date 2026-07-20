package com.sentum.drugsafe.utils;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.ArrayList;
import java.util.List;

/***
 * @author wangxm
 * @since 2020-12-10
 * @param <T>
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
public class Page<T>{
    /**
     * 当前页码
     */
    private long pageNum;
    /**
     * 每页最大条数
     */
    private long pageSize;
    /**
     * 总条数
     */
    private long total;
    /***
     * 总页数
     */
    private long pages;
    /***
     * 数据
     */
    private List<T> list=new ArrayList<>();

    public Page(List<T> tempList, long total, long pageSize, long pageNum) {
        this.pages = total / pageSize + 1;
        this.total = total;
        this.pageSize = pageSize;
        this.pageNum = pageNum;
        this.list.addAll(tempList);
    }
}
