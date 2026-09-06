import { Asset } from "cc";
import { TbContainer } from "./TbContainer";

export interface ITbDecode<T> {
    //解码
    decode( container:TbContainer<T>);
}