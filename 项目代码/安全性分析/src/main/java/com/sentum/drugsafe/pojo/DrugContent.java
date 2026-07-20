package com.sentum.drugsafe.pojo;


import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@AllArgsConstructor
@NoArgsConstructor
public class DrugContent {
    /**
     * 类型
     */
    private String tag;
    /**
     * 内容
     */
    private Object content;
}
