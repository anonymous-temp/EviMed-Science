package com.sentum.pojo.dto;

import lombok.Data;
import lombok.NoArgsConstructor;

import java.io.Serializable;
import java.util.List;

@Data
@NoArgsConstructor
public class AsynchronousVo implements Serializable {

    /**
     * 邮箱
     */
    private String mail;

    /**
     * 具体信息
     */
    private List<Asynchronous> asynchronousList;






}
